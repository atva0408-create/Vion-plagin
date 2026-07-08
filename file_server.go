package sdk

import (
	"os"

	rpc "github.com/cameraui/rpc/go"
)

type fileServeStat struct {
	Exists bool  `msgpack:"exists" json:"exists"`
	Size   int64 `msgpack:"size" json:"size"`
}

// fileServer exposes ranged reads of this worker's local files to the master,
// so downloads/exports of remote-hosted plugin files (e.g. NVR recordings)
// work. Registered only when the plugin runs remote-hosted.
type fileServer struct {
	cleanup rpc.CleanupFunc
}

func newFileServer(client *rpc.Client, pluginID string) (*fileServer, error) {
	fs := &fileServer{}
	ns := getPluginNamespaces(pluginID)

	cleanup, err := client.RegisterHandler(ns.PluginFileServeRPC, fs)
	if err != nil {
		return nil, err
	}
	fs.cleanup = cleanup
	return fs, nil
}

func (fs *fileServer) StatFile(filePath string) (fileServeStat, error) {
	info, err := os.Stat(filePath)
	if err != nil || info.IsDir() {
		return fileServeStat{Exists: false, Size: 0}, nil
	}
	return fileServeStat{Exists: true, Size: info.Size()}, nil
}

func (fs *fileServer) ReadFileChunk(filePath string, offset int64, length int64) ([]byte, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	buf := make([]byte, length)
	n, err := f.ReadAt(buf, offset)
	if err != nil && n == 0 {
		// EOF at offset with no bytes → empty chunk signals done.
		return []byte{}, nil
	}
	return buf[:n], nil
}

func (fs *fileServer) DeleteFile(filePath string) error {
	_ = os.Remove(filePath)
	return nil
}

func (fs *fileServer) close() {
	if fs.cleanup != nil {
		_ = fs.cleanup()
		fs.cleanup = nil
	}
}
