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
	bolt "go.etcd.io/bbolt"
)

// storageBucket is the bbolt bucket used for plugin-level configuration.
// One bucket per plugin DB; per-camera storage uses additional buckets keyed
// by camera ID inside the same DB.
var storageBucket = []byte("config")

// Run is the entry point a Go plugin's main package calls to hand control to
// the SDK runtime. It performs the full handshake with the host (RPC connect,
// ready/start/stop messages), opens the per-plugin storage, instantiates the
// plugin via constructor, calls ConfigureCameras with the assigned cameras,
// emits APIEventFinishLaunching, then blocks until SIGTERM/SIGINT or a stop
// command from the host. On exit it emits APIEventShutdown and tears down
// the RPC connection. This mirrors the lifecycle the Node/Python plugin
// runtimes implement (server/src/plugins/runtime/{node,python}/).
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
		pluginDB   *bolt.DB
		cleanupRPC rpc.CleanupFunc
	)

	var coreManager *CoreManager

	stopPlugin := func() {
		stoppedMu.Lock()
		if stopped {
			stoppedMu.Unlock()
			return
		}
		stopped = true
		stoppedMu.Unlock()

		if api != nil {
			api.Emit(string(APIEventShutdown))
			time.Sleep(500 * time.Millisecond)
			api.RemoveAllListeners("")
		}

		if coreManager != nil {
			coreManager.Close()
		}

		if pluginDB != nil {
			_ = pluginDB.Close()
		}

		if cleanupRPC != nil {
			_ = cleanupRPC()
		}

		_ = channel.Close()
		_ = client.Disconnect()
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

	// 8. Open bbolt DB
	storagePath := loadMsg.Storage.StoragePath
	volumePath := filepath.Join(storagePath, "volume")
	if err := os.MkdirAll(volumePath, 0755); err != nil {
		_ = channel.Send(processResponse{Type: string(PluginStatusError), Error: fmt.Sprintf("Failed to create volume dir: %v", err)})
		stopPlugin()
		return
	}

	dbPath := filepath.Join(volumePath, "plugin.db")
	pluginDB, err = bolt.Open(dbPath, 0600, &bolt.Options{Timeout: 5 * time.Second})
	if err != nil {
		_ = channel.Send(processResponse{Type: string(PluginStatusError), Error: fmt.Sprintf("Failed to open DB: %v", err)})
		stopPlugin()
		return
	}

	// Initialize the config bucket
	if err := pluginDB.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(storageBucket)
		return err
	}); err != nil {
		logger.Error("Failed to initialize config bucket:", err)
	}

	// 9. Create PluginAPI
	pluginInfo := loadMsg.Plugin

	coreManager = newCoreManager(client, logger)
	deviceManager := newDeviceManager(client, &pluginInfo, logger)
	downloadManager := newDownloadManager(client)
	notificationManager := newNotificationManager(client, &pluginInfo, logger)
	storageController := newStorageController(client, pluginDB, &pluginInfo, logger)

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
