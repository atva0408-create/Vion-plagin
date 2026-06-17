package sdk

// ImageMetadata is image metadata passed to detector test methods.
type ImageMetadata struct {
	Width  int `msgpack:"width" json:"width"`
	Height int `msgpack:"height" json:"height"`
}

// AudioMetadata is audio metadata passed to audio detector test methods.
type AudioMetadata struct {
	MimeType string `msgpack:"mimeType" json:"mimeType"`
}
