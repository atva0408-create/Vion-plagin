package sdk

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	rpc "github.com/cameraui/rpc/go"
)

// rpcTeardownTimeout bounds the final RPC teardown so a dead transport can't
// hang the process past the host's force-kill grace.
const rpcTeardownTimeout = 500 * time.Millisecond

// Run is the entry point a Go plugin's main package calls to hand control to
// the SDK runtime. It performs the full handshake with the host (RPC connect,
// ready/start/stop messages), opens the per-plugin storage, instantiates the
// plugin via constructor, calls ConfigureCameras with the assigned cameras,
// emits APIEventFinishLaunching, then blocks until SIGTERM/SIGINT or a stop
// command from the host. On exit it emits APIEventShutdown, waits (bounded)
// for the shutdown listeners to finish, and tears down the RPC connection.
func Run(constructor pluginConstructor) {
	// 1. Process title from os.Args
	processName := "Plugin"
	if len(os.Args) > 2 {
		processName = os.Args[2]
	} else if len(os.Args) > 1 {
		processName = os.Args[1]
	}

	pluginID := os.Getenv("PLUGIN_ID")

	// 2. Create RPC client
	namespaces := getPluginNamespaces(pluginID)
	client := rpc.NewClient(rpc.ClientOptions{
		Name:    namespaces.PluginChild,
		Servers: strings.Split(os.Getenv("PROXY_ENDPOINTS"), ","),
		Auth: &rpc.AuthOptions{
			User:     os.Getenv("PROXY_USER"),
			Password: os.Getenv("PROXY_PASSWORD"),
		},
	})

	// 3. Delete sensitive env vars
	for _, key := range []string{"PROXY_USER", "PROXY_PASSWORD", "PROXY_ENDPOINTS", "PROXY_CERT", "PROXY_KEY", "PROXY_CA"} {
		_ = os.Unsetenv(key)
	}

	// 4. Create logger
	loggerLevel := os.Getenv("LOGGER_LEVEL")
	logger := newLogger(&loggerOptions{
		Prefix:       processName,
		TargetID:     pluginID,
		TargetType:   "plugin",
		PluginID:     pluginID,
		DebugEnabled: loggerLevel == "debug" || loggerLevel == "trace",
		TraceEnabled: loggerLevel == "trace",
	})

	// Connect to NATS
	ctx := context.Background()
	if err := client.Connect(ctx); err != nil {
		logger.Error("Failed to connect to proxy server:", err)
		os.Exit(1)
	}

	// 5. Open private channel
	channel, err := client.PrivateChannelConnect("plugin-communication", "camera.ui")
	if err != nil {
		os.Exit(1)
	}

	// Setup shutdown handling
	var (
		stopped    bool
		stoppedMu  sync.Mutex
		stopCh     = make(chan struct{})
		api        *PluginAPI
		plugin     Plugin
		cleanupRPC rpc.CleanupFunc
		fileSrv    *fileServer
	)

	var (
		coreManager       *CoreManager
		deviceManager     *DeviceManager
		storageController *StorageController
	)

	stopPlugin := func() {
		stoppedMu.Lock()
		if stopped {
			stoppedMu.Unlock()
			return
		}
		stopped = true
		stoppedMu.Unlock()

		if api != nil {
			completed := api.emitAndWait(string(APIEventShutdown), 1*time.Second, func(recovered any) {
				logger.Error("Shutdown listener panicked:", recovered)
			})
			if !completed {
				logger.Warn("Shutdown listeners still pending after 1s, continuing teardown")
			}

			// Runtime-owned teardown, ordered and separate from the plugin's
			// SHUTDOWN listeners above: devices (+ their sensors) -> core manager
			// -> storages (flushed last so any device/sensor cleanup writes land).
			// The runtime closes them directly so the shutdown event stays purely
			// author-facing and the order stays deterministic.
			if deviceManager != nil {
				deviceManager.close()
			}
			if coreManager != nil {
				coreManager.close()
			}
			if storageController != nil {
				storageController.close()
			}

			api.RemoveAllListeners("")
		}

		// The RPC teardown can park forever when the master/NATS is already gone.
		// Bound it so the process exits well within the host's force-kill grace
		// instead of hanging on a dead transport.
		done := make(chan struct{})
		go func() {
			if cleanupRPC != nil {
				_ = cleanupRPC()
			}
			if fileSrv != nil {
				fileSrv.close()
			}
			_ = channel.Close()
			_ = client.Disconnect()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(rpcTeardownTimeout):
			logger.Warn("RPC teardown still pending after 500ms, exiting anyway")
		}
	}

	// 6. Register message handler BEFORE sending ready (avoid race condition)
	startCh := make(chan *processLoadMessage, 1)

	channel.OnMessage(func(data any) {
		stoppedMu.Lock()
		isStopped := stopped
		stoppedMu.Unlock()
		if isStopped {
			return
		}

		// data is typically map[string]any from msgpack
		msgMap, ok := data.(map[string]any)
		if !ok {
			return
		}

		msgType, _ := msgMap["type"].(string)

		switch msgType {
		case string(pluginCommandStart):
			rawData := msgMap["data"]
			if rawData == nil {
				_ = channel.Send(processResponse{Type: string(PluginStatusError), Error: "No data provided"})
				return
			}

			// Re-encode and decode to get proper typed struct
			encoded, err := rpc.Encode(rawData)
			if err != nil {
				_ = channel.Send(processResponse{Type: string(PluginStatusError), Error: fmt.Sprintf("Failed to encode data: %v", err)})
				return
			}

			var loadMsg processLoadMessage
			if err := rpc.Decode(encoded, &loadMsg); err != nil {
				_ = channel.Send(processResponse{Type: string(PluginStatusError), Error: fmt.Sprintf("Failed to decode data: %v", err)})
				return
			}

			select {
			case startCh <- &loadMsg:
			default:
			}

		case string(pluginCommandStop):
			select {
			case stopCh <- struct{}{}:
			default:
			}
		}
	})

	// 7. Send ready (after OnMessage is registered to avoid race condition)
	if err := channel.Send(processResponse{Type: string(PluginStatusReady)}); err != nil {
		stopPlugin()
		os.Exit(1)
	}

	// Wait for start message
	var loadMsg *processLoadMessage
	select {
	case loadMsg = <-startCh:
	case <-stopCh:
		stopPlugin()
		return
	}

	// 8. Configure persistence. Host-local writable dir first — on a remote
	// worker the master's path from the START message would point at the
	// wrong machine.
	storagePath := loadMsg.Storage.StoragePath
	if envPath := os.Getenv("PLUGIN_STORAGE_PATH"); envPath != "" {
		storagePath = envPath
	}

	pluginInfo := loadMsg.Plugin

	var persistence configPersistence

	if os.Getenv("PLUGIN_CONFIG_STORE_RPC") != "" {
		// Remote-hosted: config lives on the master (re-homing safe) —
		// persist through its config store instead of a worker-local file.
		remote, err := newRemotePersistence(client, pluginInfo.ID, logger)
		if err != nil {
			_ = channel.Send(processResponse{Type: string(PluginStatusError), Error: fmt.Sprintf("Failed to connect config store: %v", err)})
			stopPlugin()
			return
		}
		persistence = remote
	} else {
		storePath := filepath.Join(storagePath, "volume", storeFileName)
		local, err := newFilePersistence(storePath, pluginInfo.ID, logger)
		if err != nil {
			_ = channel.Send(processResponse{Type: string(PluginStatusError), Error: fmt.Sprintf("Failed to open config store: %v", err)})
			stopPlugin()
			return
		}
		persistence = local
	}

	// 9. Create PluginAPI

	coreManager = newCoreManager(client, logger)
	deviceManager = newDeviceManager(client, &pluginInfo, logger)
	downloadManager := newDownloadManager(client)

	// Remote-hosted: serve this worker's files so the master can stream
	// downloads/exports of them.
	if os.Getenv("PLUGIN_REMOTE_MODE") != "" {
		fileSrv, err = newFileServer(client, pluginInfo.ID)
		if err != nil {
			_ = channel.Send(processResponse{Type: string(PluginStatusError), Error: fmt.Sprintf("Failed to register file server: %v", err)})
			stopPlugin()
			return
		}
	}
	notificationManager := newNotificationManager(client, &pluginInfo, logger)
	storageController = newStorageController(client, persistence, &pluginInfo, logger)

	api = newPluginAPI(coreManager, deviceManager, downloadManager, notificationManager, storageController, storagePath)
	deviceManager.setAPI(api, storageController)

	// 10. Construct plugin
	pluginStorage, err := storageController.createStorage("plugin")
	if err != nil {
		_ = channel.Send(processResponse{Type: string(PluginStatusError), Error: fmt.Sprintf("Failed to create storage: %v", err)})
		stopPlugin()
		return
	}

	plugin = constructor(logger, api, pluginStorage)

	// 11. If StorageSchemaProvider -> define schemas
	if schemaProvider, ok := plugin.(StorageSchemaProvider); ok {
		schemas := schemaProvider.StorageSchema()
		if len(schemas) > 0 {
			pluginStorage.DefineSchemas(schemas)
		}
	}

	// 12. Register RPC handler
	cleanupRPC, err = client.RegisterHandler(namespaces.PluginChildRPC, plugin)
	if err != nil {
		_ = channel.Send(processResponse{Type: string(PluginStatusError), Error: fmt.Sprintf("Failed to register handler: %v", err)})
		stopPlugin()
		return
	}

	// 13. Init managers
	deviceManager.setPlugin(plugin)
	if err := deviceManager.init(); err != nil {
		_ = channel.Send(processResponse{Type: string(PluginStatusError), Error: fmt.Sprintf("Failed to init device manager: %v", err)})
		stopPlugin()
		return
	}
	if err := coreManager.init(); err != nil {
		_ = channel.Send(processResponse{Type: string(PluginStatusError), Error: fmt.Sprintf("Failed to init core manager: %v", err)})
		stopPlugin()
		return
	}

	// 14. Configure cameras
	cameras := loadMsg.Cameras
	cameraDevices := make([]*CameraDevice, 0, len(cameras))
	for i := range cameras {
		cam := &cameras[i]
		camLogger := logger.CreateLogger(&loggerOptions{
			Suffix:     cam.Name,
			TargetID:   cam.ID,
			TargetType: "camera",
		})
		cameraDevice := newCameraDeviceProxy(client, api, storageController, cam, &pluginInfo, camLogger)
		if err := cameraDevice.init(); err != nil {
			_ = channel.Send(processResponse{Type: string(PluginStatusError), Error: fmt.Sprintf("Failed to init camera device %s: %v", cam.Name, err)})
			stopPlugin()
			return
		}
		cameraDevices = append(cameraDevices, cameraDevice)
	}

	deviceManager.configureCameras(cameraDevices)

	if err := plugin.ConfigureCameras(cameraDevices); err != nil {
		_ = channel.Send(processResponse{Type: string(PluginStatusError), Error: fmt.Sprintf("ConfigureCameras failed: %v", err)})
		stopPlugin()
		return
	}

	// 15. Send started
	_ = channel.Send(processResponse{Type: string(PluginStatusStarted)})

	time.Sleep(100 * time.Millisecond)

	// 16. Emit finishLaunching
	api.Emit(string(APIEventFinishLaunching))

	// 17. Block on signal or stop command
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

	select {
	case <-sigCh:
	case <-stopCh:
	}

	// 18. Shutdown
	stopPlugin()
}
