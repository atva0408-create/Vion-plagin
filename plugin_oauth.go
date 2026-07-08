package sdk

// OAuthStatus is the lifecycle phase of an OAuth provider connection, carried
// in OAuthState.Status.
type OAuthStatus = string

const (
	OAuthStatusDisconnected OAuthStatus = "disconnected"
	OAuthStatusAwaitingUser OAuthStatus = "awaiting_user"
	OAuthStatusPolling      OAuthStatus = "polling"
	OAuthStatusConnected    OAuthStatus = "connected"
	OAuthStatusError        OAuthStatus = "error"
)

// OAuthState is a snapshot of a provider connection's lifecycle. It lives in
// the plugin and is the source of truth for both the host UI and downstream
// plugin code that needs a token. The host polls it via GetOAuthState while a
// flow is in progress.
type OAuthState struct {
	// Status is the current lifecycle phase (see OAuthStatus values).
	Status OAuthStatus `msgpack:"status" json:"status"`

	// UserCode / VerificationURI / VerificationURIComplete are set while a
	// Device Flow is awaiting the user. VerificationURIComplete embeds the
	// user code and is what the host renders as a QR code.
	UserCode                string `msgpack:"userCode,omitempty" json:"userCode,omitempty"`
	VerificationURI         string `msgpack:"verificationUri,omitempty" json:"verificationUri,omitempty"`
	VerificationURIComplete string `msgpack:"verificationUriComplete,omitempty" json:"verificationUriComplete,omitempty"`

	// AuthURL is set while an Authorization Code Flow is awaiting the user —
	// the URL the browser must open to authorize.
	AuthURL string `msgpack:"authUrl,omitempty" json:"authUrl,omitempty"`

	// UserEmail / ConnectedAt / ScopesGranted describe an established grant
	// (Status connected). ConnectedAt is a Unix timestamp.
	UserEmail     string   `msgpack:"userEmail,omitempty" json:"userEmail,omitempty"`
	ConnectedAt   int64    `msgpack:"connectedAt,omitempty" json:"connectedAt,omitempty"`
	ScopesGranted []string `msgpack:"scopesGranted,omitempty" json:"scopesGranted,omitempty"`

	// ErrorCode / ErrorMessage are set while Status is error. ErrorCode uses
	// OAuth spec values ("access_denied", "expired_token", "server_error").
	ErrorCode    string `msgpack:"errorCode,omitempty" json:"errorCode,omitempty"`
	ErrorMessage string `msgpack:"errorMessage,omitempty" json:"errorMessage,omitempty"`
}

// OAuthMetadata is informational data the host renders in the connect dialog.
type OAuthMetadata struct {
	// IdpDisplayName is the human name of the identity provider, e.g.
	// "cameraui.com", "Spotify", "GitHub".
	IdpDisplayName string `msgpack:"idpDisplayName" json:"idpDisplayName"`
	// ScopeDescriptions maps each scope to a human-readable description.
	ScopeDescriptions map[string]string `msgpack:"scopeDescriptions" json:"scopeDescriptions"`
	// SupportedFlows lists the flow sub-interfaces the plugin implements, so
	// the host knows which connect affordance to render.
	SupportedFlows []PluginInterface `msgpack:"supportedFlows" json:"supportedFlows"`
}

// OAuthProviderConfig points the plugin's OAuth manager at an identity
// provider.
type OAuthProviderConfig struct {
	// Preset names a built-in IdP endpoint set. When empty the explicit
	// endpoint fields are used.
	Preset string `msgpack:"preset,omitempty" json:"preset,omitempty"`
	// DeviceAuthURL / TokenURL / RevokeURL are the IdP endpoints used when
	// Preset is empty.
	DeviceAuthURL string `msgpack:"deviceAuthUrl,omitempty" json:"deviceAuthUrl,omitempty"`
	AuthURL       string `msgpack:"authUrl,omitempty" json:"authUrl,omitempty"`
	TokenURL      string `msgpack:"tokenUrl,omitempty" json:"tokenUrl,omitempty"`
	RevokeURL     string `msgpack:"revokeUrl,omitempty" json:"revokeUrl,omitempty"`
}

// OAuthProviderDeclaration is one provider a plugin integrates with. A
// single-provider plugin declares exactly one.
type OAuthProviderDeclaration struct {
	// ID is the plugin-local provider identifier (storage key dimension for
	// multi-provider plugins).
	ID string `msgpack:"id" json:"id"`
	// Provider configures the IdP endpoints.
	Provider OAuthProviderConfig `msgpack:"provider" json:"provider"`
	// ClientID is the OAuth client id the plugin authenticates as.
	ClientID string `msgpack:"clientId" json:"clientId"`
	// Scopes are the scopes requested for this provider.
	Scopes []string `msgpack:"scopes" json:"scopes"`
	// Required marks the provider as mandatory for the plugin to function.
	Required bool `msgpack:"required,omitempty" json:"required,omitempty"`
	// Description is a one-line UI hint shown alongside the connect button.
	Description string `msgpack:"description,omitempty" json:"description,omitempty"`
}

// OAuthCapable is the base interface every OAuth-capable plugin implements,
// alongside at least one flow sub-interface (Device / AuthCode /
// ClientCredentials). It is IdP-agnostic — the plugin brings its own endpoint
// config and knows nothing about the host's internals.
type OAuthCapable interface {
	// GetOAuthMetadata returns the IdP display info, scope descriptions and
	// which flow sub-interfaces the plugin implements. Called on UI mount.
	GetOAuthMetadata() (*OAuthMetadata, error)
	// GetOAuthState returns a snapshot of the current lifecycle state; the
	// host polls this to mirror progress.
	GetOAuthState() (*OAuthState, error)
	// Disconnect revokes the current grant at the IdP and clears the stored
	// tokens.
	Disconnect() error
}

// OAuthDeviceFlowCapable is implemented by plugins whose IdP supports the
// RFC 8628 Device Authorization Grant. The plugin polls the IdP internally;
// the host only polls GetOAuthState to mirror progress.
type OAuthDeviceFlowCapable interface {
	OAuthCapable
	// StartDeviceFlow requests a device code for the given scopes and begins
	// polling the IdP. Returns the awaiting-user state (code + verification
	// URI) for the UI to render.
	StartDeviceFlow(scope []string) (*OAuthState, error)
	// CancelDeviceFlow aborts an in-progress device flow.
	CancelDeviceFlow() error
}

// OAuthAuthCodeFlowCapable is implemented by plugins that use the OAuth 2.0
// Authorization Code Flow with PKCE. The plugin builds the auth URL (keeping
// the PKCE verifier internal); the host opens it and, on IdP redirect to
// /oauth/callback/:pluginId, forwards the code+state to CompleteAuthCodeFlow.
type OAuthAuthCodeFlowCapable interface {
	OAuthCapable
	// StartAuthCodeFlow builds the authorization URL for the given scopes and
	// returns the awaiting-user state (AuthURL set).
	StartAuthCodeFlow(scope []string) (*OAuthState, error)
	// CompleteAuthCodeFlow exchanges the IdP-returned code for tokens after
	// validating state against the value bound in StartAuthCodeFlow.
	CompleteAuthCodeFlow(code, state string) (*OAuthState, error)
	// CancelAuthCodeFlow aborts an in-progress authorization-code flow.
	CancelAuthCodeFlow() error
}

// OAuthClientCredentialsCapable is implemented by plugins that authenticate
// with a user-supplied client_id + client_secret (no user redirect). The
// plugin validates by fetching a token immediately.
type OAuthClientCredentialsCapable interface {
	OAuthCapable
	// ConfigureClientCredentials stores the supplied credentials and fetches
	// an initial token to validate them, returning the resulting state.
	ConfigureClientCredentials(clientID, clientSecret string) (*OAuthState, error)
}
