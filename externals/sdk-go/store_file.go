package sdk

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/vmihailenco/msgpack/v5"
)

const storeFileName = "store.cui"

// envelope is magic + msgpack payload + little-endian CRC32 (IEEE) of the payload
var storeMagic = []byte("CUI1")

var renameRetryDelays = []time.Duration{
	10 * time.Millisecond,
	25 * time.Millisecond,
	60 * time.Millisecond,
	150 * time.Millisecond,
	300 * time.Millisecond,
}

// only corruption triggers the backup fallback, an I/O error must not
type storeCorruptError struct{ reason string }

func (e *storeCorruptError) Error() string { return "store envelope: " + e.reason }

func encodeEnvelope(payload map[string]any) ([]byte, error) {
	body, err := msgpack.Marshal(payload)
	if err != nil {
		return nil, err
	}
	buf := make([]byte, 0, len(storeMagic)+len(body)+4)
	buf = append(buf, storeMagic...)
	buf = append(buf, body...)
	buf = binary.LittleEndian.AppendUint32(buf, crc32.ChecksumIEEE(body))
	return buf, nil
}

func decodeEnvelope(buf []byte) (map[string]any, error) {
	if len(buf) < len(storeMagic)+4 || !bytes.Equal(buf[:len(storeMagic)], storeMagic) {
		return nil, &storeCorruptError{"bad magic"}
	}
	body := buf[len(storeMagic) : len(buf)-4]
	if crc32.ChecksumIEEE(body) != binary.LittleEndian.Uint32(buf[len(buf)-4:]) {
		return nil, &storeCorruptError{"crc mismatch"}
	}
	var raw any
	if err := msgpack.Unmarshal(body, &raw); err != nil {
		return nil, &storeCorruptError{"payload decode failed: " + err.Error()}
	}
	payload, ok := normalizeStoreValue(raw).(map[string]any)
	if !ok {
		return nil, &storeCorruptError{"payload is not a map"}
	}
	return payload, nil
}

// consumers rely on map[string]any and int64 (uint64 only above the int64
// range), the decoder returns the narrowest type that fits
func normalizeStoreValue(v any) any {
	switch val := v.(type) {
	case map[string]any:
		for k, item := range val {
			val[k] = normalizeStoreValue(item)
		}
		return val
	case map[any]any:
		out := make(map[string]any, len(val))
		for k, item := range val {
			key, ok := k.(string)
			if !ok {
				key = fmt.Sprint(k)
			}
			out[key] = normalizeStoreValue(item)
		}
		return out
	case []any:
		for i, item := range val {
			val[i] = normalizeStoreValue(item)
		}
		return val
	case int:
		return int64(val)
	case int8:
		return int64(val)
	case int16:
		return int64(val)
	case int32:
		return int64(val)
	case uint:
		return normalizeStoreUint(uint64(val))
	case uint8:
		return int64(val)
	case uint16:
		return int64(val)
	case uint32:
		return int64(val)
	case uint64:
		return normalizeStoreUint(val)
	case float32:
		return float64(val)
	default:
		return v
	}
}

func normalizeStoreUint(v uint64) any {
	if v > math.MaxInt64 {
		return v
	}
	return int64(v)
}

func renameWithRetry(tmpPath, path string) error {
	for attempt := 0; ; attempt++ {
		err := os.Rename(tmpPath, path)
		if err == nil {
			return nil
		}
		retryable := runtime.GOOS == "windows" && errors.Is(err, fs.ErrPermission)
		if !retryable || attempt >= len(renameRetryDelays) {
			return err
		}
		time.Sleep(renameRetryDelays[attempt])
	}
}

func writeStoreBytes(path string, buf []byte, log *Logger) error {
	tmpPath := path + ".tmp-" + strconv.Itoa(os.Getpid())

	err := func() error {
		f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
		if errors.Is(err, fs.ErrNotExist) {
			// the volume can be pulled away under a running plugin (backup
			// restore, manual cleanup), writing again must recreate it
			if mkErr := os.MkdirAll(filepath.Dir(path), 0o755); mkErr != nil {
				return err
			}
			f, err = os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
		}
		if err != nil {
			return err
		}
		if _, err := f.Write(buf); err != nil {
			_ = f.Close()
			return err
		}
		if err := f.Sync(); err != nil {
			_ = f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
		return renameWithRetry(tmpPath, path)
	}()
	if err != nil {
		_ = os.Remove(tmpPath)
		log.Error(fmt.Sprintf("store: write %s failed: %v", path, err))
		return err
	}

	return nil
}

func writeStoreFile(path string, payload map[string]any, log *Logger) error {
	buf, err := encodeEnvelope(payload)
	if err != nil {
		log.Error(fmt.Sprintf("store: encode for %s failed: %v", path, err))
		return err
	}
	return writeStoreBytes(path, buf, log)
}

// a corrupt store must never silently become an empty one, that would discard
// the plugin's persisted state, so an unusable backup fails the open
func readStoreFile(path string, log *Logger) (payload map[string]any, found bool, err error) {
	buf, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, err
	}

	payload, err = decodeEnvelope(buf)
	if err == nil {
		return payload, true, nil
	}
	if _, ok := errors.AsType[*storeCorruptError](err); !ok {
		return nil, false, err
	}
	log.Error(fmt.Sprintf("store: %s is corrupt (%v), trying backup", path, err))

	bakPath := path + ".bak"
	if bakBuf, bakErr := os.ReadFile(bakPath); bakErr == nil {
		payload, err := decodeEnvelope(bakBuf)
		if err == nil {
			// Self-heal: replace the corrupt file immediately, otherwise the
			// next backup refresh would clobber the only good copy.
			if err := writeStoreBytes(path, bakBuf, log); err != nil {
				return nil, false, err
			}
			log.Warn(fmt.Sprintf("store: recovered %s from backup (%d bytes)", path, len(bakBuf)))
			return payload, true, nil
		}
		log.Error(fmt.Sprintf("store: backup %s is corrupt too (%v)", bakPath, err))
	}

	return nil, false, &storeCorruptError{path + " unreadable and no usable backup"}
}

// temp sibling first, a crash mid-copy must not leave a truncated .bak, it may
// be the only recovery generation
func backupStoreFile(path string, log *Logger) {
	tmpPath := path + ".bak.tmp-" + strconv.Itoa(os.Getpid())
	err := func() error {
		src, err := os.Open(path)
		if err != nil {
			return err
		}
		defer func() { _ = src.Close() }()

		dst, err := os.Create(tmpPath)
		if err != nil {
			return err
		}
		if _, err := io.Copy(dst, src); err != nil {
			_ = dst.Close()
			return err
		}
		if err := dst.Close(); err != nil {
			return err
		}
		return renameWithRetry(tmpPath, path+".bak")
	}()
	if err != nil {
		_ = os.Remove(tmpPath)
		if !errors.Is(err, fs.ErrNotExist) {
			log.Warn(fmt.Sprintf("store: backup for %s failed: %v", path, err))
		}
		return
	}
}

func removeOrphanedStoreTmpFiles(path string) {
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		return
	}
	prefix := filepath.Base(path)
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, prefix) && strings.Contains(name, ".tmp-") {
			_ = os.Remove(filepath.Join(filepath.Dir(path), name))
		}
	}
}
