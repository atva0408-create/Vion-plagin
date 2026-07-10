package sdk

import (
	"context"
	"errors"
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

// errStopRequested signals that a host STOP arrived mid-startup, so the plugin
// tears down immediately instead of reporting a startup error and waiting.
var errStopRequested = errors.New("stop requested during startup")

const shutdownListenerTimeout = 1500 * time.Millisecond
const rpcTeardownTimeout = 500 * time.Millisecond

const gracefulShutdownTimeout = 2 * time.Second

// Run is the entry point a Go plugin's main package calls to hand control to
// the SDK runtime.
func Run(constructor pluginConstructor) {
	processName := "Plugin"
	if len(os.Args) > 2 {
		processName = os.Args[2]
	} else if len(os.Args) > 1 {
		processName = os.Args[1]
	}

	pluginID := os.Getenv("PLUGIN_ID")

	namespaces := getPluginNamespaces(pluginID)
	client := rpc.NewClient(rpc.ClientOptions{
		Name:    namespaces.PluginChild,
		Servers: strings.Split(os.Getenv("PROXY_ENDPOINTS"), ","),
		Auth: &rpc.AuthOptions{
			User:     os.Getenv("PROXY_USER"),
			Password: os.Getenv("PROXY_PASSWORD"),
		},
	})

	for _, key := range []string{"PROXY_USER", "PROXY_PASSWORD", "PROXY_ENDPOINTS", "PROXY_CERT", "PROXY_KEY", "PROXY_CA"} {
		_ = os.Unsetenv(key)
	}

	loggerLevel := os.Getenv("LOGGER_LEVEL")
	logger := newLogger(&loggerOptions{
		Prefix:       processName,
		TargetID:     pluginID,
		TargetType:   "plugin",
		PluginID:     pluginID,
		DebugEnabled: loggerLevel == "debug" || loggerLevel == "trace",
		TraceEnabled: loggerLevel == "trace",
	})

	ctx := context.Background()
	if err := client.Connect(ctx); err != nil {
		logger.Error("Failed to connect to proxy server:", err)
		os.Exit(1)
	}

	channel, err := client.PrivateChannelConnect("plugin-communication", "camera.ui")
	if err != nil {
		os.Exit(1)
	}

	var (
		stopped    bool
		stoppedMu  sync.Mutex
		stopCh     = make(chan struct{}, 1)
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
			completed := api.emitAndWait(string(APIEventShutdown), shutdownListenerTimeout, func(recovered any) {
				logger.Error("Shutdown listener panicked:", recovered)
			})
			if !completed {
				logger.Warn("Shutdown listeners still pending after", shutdownListenerTimeout, ", continuing teardown")
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
			logger.Warn("RPC teardown still pending after", rpcTeardownTimeout, ", exiting anyway")
		}
	}

	stopPluginBounded := func() {
		done := make(chan struct{})
		go func() {
			stopPlugin()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(gracefulShutdownTimeout):
			logger.Warn("Graceful shutdown exceeded deadline, forcing exit")
		}
	}

	// The watcher only funnels into stopCh so stopPlugin stays owned by the main
	// goroutine — no data race on the shared handles it tears down.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		select {
		case stopCh <- struct{}{}:
		default:
		}
	}()

	// stopRequested reports a pending stop (host STOP command or signal) so the
	// startup steps can bail out between them instead of running to completion.
	stopRequested := func() bool {
		select {
		case <-stopCh:
			return true
		default:
			return false
		}
	}

	// Register the message handler before sending ready so a START/STOP that
	// races in right after ready is never missed.
	startCh := make(chan *processLoadMessage, 1)

	channel.OnMessage(func(data any) {
		stoppedMu.Lock()
		isStopped := stopped
		stoppedMu.Unlock()
		if isStopped {
			return
		}

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

	if err := channel.Send(processResponse{Type: string(PluginStatusReady)}); err != nil {
		stopPlugin()
		os.Exit(1)
	}

	defer func() {
		if r := recover(); r != nil {
			logger.Error("Plugin panicked:", r)
			stopPluginBounded()
			os.Exit(1)
		}
	}()

	var loadMsg *processLoadMessage
	select {
	case loadMsg = <-startCh:
	case <-stopCh:
		stopPlugin()
		return
	}

	startPlugin := func() error {
		storagePath := loadMsg.Storage.StoragePath
		if envPath := os.Getenv("PLUGIN_STORAGE_PATH"); envPath != "" {
			storagePath = envPath
		}

		pluginInfo := loadMsg.Plugin

		var persistence configPersistence
		if os.Getenv("PLUGIN_CONFIG_STORE_RPC") != "" {
			remote, err := newRemotePersistence(client, pluginInfo.ID, logger)
			if err != nil {
				return fmt.Errorf("failed to connect config store: %w", err)
			}
			persistence = remote
		} else {
			storePath := filepath.Join(storagePath, "volume", storeFileName)
			local, err := newFilePersistence(storePath, pluginInfo.ID, logger)
			if err != nil {
				return fmt.Errorf("failed to open config store: %w", err)
			}
			persistence = local
		}

		if stopRequested() {
			return errStopRequested
		}

		coreManager = newCoreManager(client, logger)
		deviceManager = newDeviceManager(client, &pluginInfo, logger)
		downloadManager := newDownloadManager(client)

		if os.Getenv("PLUGIN_REMOTE_MODE") != "" {
			fs, err := newFileServer(client, pluginInfo.ID)
			if err != nil {
				return fmt.Errorf("failed to register file server: %w", err)
			}
			fileSrv = fs
		}
		notificationManager := newNotificationManager(client, &pluginInfo, logger)
		storageController = newStorageController(client, persistence, &pluginInfo, logger)

		api = newPluginAPI(coreManager, deviceManager, downloadManager, notificationManager, storageController, storagePath)
		deviceManager.setAPI(api, storageController)

		pluginStorage, err := storageController.createStorage("plugin")
		if err != nil {
			return fmt.Errorf("failed to create storage: %w", err)
		}

		plugin = constructor(logger, api, pluginStorage)

		if schemaProvider, ok := plugin.(StorageSchemaProvider); ok {
			schemas := schemaProvider.StorageSchema()
			if len(schemas) > 0 {
				pluginStorage.DefineSchemas(schemas)
			}
		}

		cleanupRPC, err = client.RegisterHandler(namespaces.PluginChildRPC, plugin)
		if err != nil {
			return fmt.Errorf("failed to register handler: %w", err)
		}

		if stopRequested() {
			return errStopRequested
		}

		deviceManager.setPlugin(plugin)
		if err := deviceManager.init(); err != nil {
			return fmt.Errorf("failed to init device manager: %w", err)
		}
		if err := coreManager.init(); err != nil {
			return fmt.Errorf("failed to init core manager: %w", err)
		}

		if stopRequested() {
			return errStopRequested
		}

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
				return fmt.Errorf("failed to init camera device %s: %w", cam.Name, err)
			}
			cameraDevices = append(cameraDevices, cameraDevice)
		}

		deviceManager.configureCameras(cameraDevices)

		if err := plugin.ConfigureCameras(cameraDevices); err != nil {
			return fmt.Errorf("ConfigureCameras failed: %w", err)
		}

		if stopRequested() {
			return errStopRequested
		}

		return nil
	}

	switch startErr := startPlugin(); {
	case startErr == nil:
		_ = channel.Send(processResponse{Type: string(PluginStatusStarted)})
		time.Sleep(100 * time.Millisecond)
		api.Emit(string(APIEventFinishLaunching))
	case errors.Is(startErr, errStopRequested):
		stopPlugin()
		return
	default:
		// Startup failed: report ERROR and stay alive so the host decides (send
		// STOP), matching node/python which never self-terminate here.
		_ = channel.Send(processResponse{Type: string(PluginStatusError), Error: startErr.Error()})
	}

	<-stopCh

	stopPluginBounded()
}
