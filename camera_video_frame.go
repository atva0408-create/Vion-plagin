package sdk

import "image"

// DecoderFormat is the internal decoder output format.
type DecoderFormat string

const (
	DecoderFormatNV12 DecoderFormat = "nv12"
)

// ImageInputFormat is a supported image input format for processing.
type ImageInputFormat string

const (
	ImageInputFormatNV12 ImageInputFormat = "nv12"
	ImageInputFormatRGB  ImageInputFormat = "rgb"
	ImageInputFormatRGBA ImageInputFormat = "rgba"
	ImageInputFormatGray ImageInputFormat = "gray"
)

// ImageOutputFormat is a supported image output format after processing.
type ImageOutputFormat string

const (
	ImageOutputFormatRGB  ImageOutputFormat = "rgb"
	ImageOutputFormatRGBA ImageOutputFormat = "rgba"
	ImageOutputFormatGray ImageOutputFormat = "gray"
)

// FrameMetadata is decoded frame metadata from the video decoder.
type FrameMetadata struct {
	// Format is the decoder format.
	Format DecoderFormat `msgpack:"format" json:"format"`
	// FrameSize is the total frame data size in bytes.
	FrameSize int `msgpack:"frameSize" json:"frameSize"`
	// Width is the current frame width (may be scaled).
	Width int `msgpack:"width" json:"width"`
	// Height is the current frame height (may be scaled).
	Height int `msgpack:"height" json:"height"`
	// OrigWidth is the original video width before scaling.
	OrigWidth int `msgpack:"origWidth" json:"origWidth"`
	// OrigHeight is the original video height before scaling.
	OrigHeight int `msgpack:"origHeight" json:"origHeight"`
}

// ImageInformation describes image dimensions and format.
type ImageInformation struct {
	// Width is the image width in pixels.
	Width int `msgpack:"width" json:"width"`
	// Height is the image height in pixels.
	Height int `msgpack:"height" json:"height"`
	// Channels is the number of color channels (1=gray, 3=RGB, 4=RGBA).
	Channels int `msgpack:"channels" json:"channels"`
	// Format is the pixel format.
	Format ImageInputFormat `msgpack:"format" json:"format"`
}

// ImageCrop is a crop region for image processing.
type ImageCrop struct {
	// Top is the top offset in pixels.
	Top int `msgpack:"top" json:"top"`
	// Left is the left offset in pixels.
	Left int `msgpack:"left" json:"left"`
	// Width is the crop width in pixels.
	Width int `msgpack:"width" json:"width"`
	// Height is the crop height in pixels.
	Height int `msgpack:"height" json:"height"`
}

// ImageResize is the target dimensions for resize processing.
type ImageResize struct {
	// Width is the target width in pixels.
	Width int `msgpack:"width" json:"width"`
	// Height is the target height in pixels.
	Height int `msgpack:"height" json:"height"`
}

// ImageFormat is an output format conversion option.
type ImageFormat struct {
	// To is the target pixel format.
	To ImageOutputFormat `msgpack:"to" json:"to"`
}

// ImageOptions combines image processing options.
type ImageOptions struct {
	// Format is the output format conversion option.
	Format *ImageFormat `msgpack:"format,omitempty" json:"format,omitempty"`
	// Crop is the optional crop region.
	Crop *ImageCrop `msgpack:"crop,omitempty" json:"crop,omitempty"`
	// Resize is the optional resize dimensions.
	Resize *ImageResize `msgpack:"resize,omitempty" json:"resize,omitempty"`
}

// FrameBuffer is a processed image as a raw pixel buffer with metadata.
type FrameBuffer struct {
	// Image is the raw pixel data.
	Image []byte `msgpack:"image" json:"image"`
	// Info is the image information.
	Info ImageInformation `msgpack:"info" json:"info"`
}

// FrameImage is a processed image as a Go standard-library image with metadata.
type FrameImage struct {
	// Image is the standard-library image instance for further processing.
	Image image.Image `msgpack:"-" json:"-"`
	// Info is the image information.
	Info ImageInformation `msgpack:"info" json:"info"`
}

// FrameData is raw frame data from the decoder.
type FrameData struct {
	// ID is the unique frame identifier.
	ID string `msgpack:"id" json:"id"`
	// Data is the raw frame pixel data.
	Data []byte `msgpack:"data" json:"data"`
	// Timestamp is the frame capture timestamp.
	Timestamp int64 `msgpack:"timestamp" json:"timestamp"`
	// Metadata is the decoder metadata.
	Metadata FrameMetadata `msgpack:"metadata" json:"metadata"`
	// Info is the image information.
	Info ImageInformation `msgpack:"info" json:"info"`
}

// ImageMetadata is image metadata passed to detector test methods.
type ImageMetadata struct {
	Width  int `msgpack:"width" json:"width"`
	Height int `msgpack:"height" json:"height"`
}

// AudioMetadata is audio metadata passed to audio detector test methods.
type AudioMetadata struct {
	MimeType string `msgpack:"mimeType" json:"mimeType"`
}

// VideoFrame is a video frame with processing capabilities.
// Provides methods to convert raw decoder output to usable image formats.
type VideoFrame interface {
	ID() string
	Data() []byte
	Metadata() FrameMetadata
	Info() ImageInformation
	Timestamp() int64
	InputWidth() int
	InputHeight() int
	InputFormat() DecoderFormat
	ToBuffer() (*FrameBuffer, error)
	ToImage() (*FrameImage, error)
}
