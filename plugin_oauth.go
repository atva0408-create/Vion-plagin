package sdk

// OAuthStatus is the lifecycle phase of an OAuth provider connection, carried
// in OAuthState.Status.
type OAuthStatus = string

const (
	// OAuthStatusDisconnected means no grant is stored.
	OAuthStatusDisconnected OAuthStatus = "disconnected"
	// OAuthStatusAwaitingUser means the user still has to authorize the flow.
	OAuthStatusAwaitingUser OAuthStatus = "awaiting_user"
	// OAuthStatusPolling means the plugin is polling the IdP for the token.
	OAuthStatusPolling OAuthStatus = "polling"
	// OAuthStatusConnected means a usable grant is stored.
	OAuthStatusConnected OAuthStatus = "connected"
	// OAuthStatusError means the flow failed; see ErrorCode and ErrorMessage.
	OAuthStatusError OAuthStatus = "error"
)

// OAuthState is a snapshot of a provider connection's lifecycle. It lives in
// the plugin and is the source of truth for both the host UI and downstream
// plugin code that needs a token. The host polls it via GetOAuthState while a
// flow is in progress.
type OAuthState struct {
	// Status is the current lifecycle phase (see OAuthStatus values).
	Status OAuthStatus `msgpack:"status" json:"status"`

	// UserCode is the device-flow user code shown to the user (set while
	// awaiting_user).
	UserCode string `msgpack:"userCode,omitempty" json:"userCode,omitempty"`
	// VerificationURI is the device-flow verification URI the user opens (set
	// while awaiting_user).
	VerificationURI string `msgpack:"verificationUri,omitempty" json:"verificationUri,omitempty"`
	// VerificationURIComplete is the verification URI with the user code
	// embedded, rendered as a QR code.
	VerificationURIComplete string `msgpack:"verificationUriComplete,omitempty" json:"verificationUriComplete,omitempty"`
	// AuthURL is the authorization-code-flow URL the browser must open (set
	// while awaiting_user).
	AuthURL string `msgpack:"authUrl,omitempty" json:"authUrl,omitempty"`
	// UserEmail is the connected account email (set while connected).
	UserEmail string `msgpack:"userEmail,omitempty" json:"userEmail,omitempty"`
	// ConnectedAt is the Unix timestamp the grant was established (set while
	// connected).
	ConnectedAt int64 `msgpack:"connectedAt,omitempty" json:"connectedAt,omitempty"`
	// ScopesGranted are the scopes granted by the IdP (set while connected).
	ScopesGranted []string `msgpack:"scopesGranted,omitempty" json:"scopesGranted,omitempty"`
	// ErrorCode is the OAuth error code (set while error): access_denied,
	// expired_token, server_error.
	ErrorCode string `msgpack:"errorCode,omitempty" json:"errorCode,omitempty"`
	// ErrorMessage is the human-readable error detail (set while error).
	ErrorMessage string `msgpack:"errorMessage,omitempty" json:"errorMessage,omitempty"`
}

// OAuthMetadata is informational data the host renders in the connect dialog.
type OAuthMetadata struct {
	// IdpDisplayName is the human name of the identity provider, e.g.
	// "cameraui.com", "Spotify".
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
	// Preset names a built-in IdP endpoint set, e.g. "cameraui.com". When
	// empty the explicit endpoint fields are used.
	Preset string `msgpack:"preset,omitempty" json:"preset,omitempty"`
	// DeviceAuthURL is the device-authorization endpoint (used when Preset is
	// empty).
	DeviceAuthURL string `msgpack:"deviceAuthUrl,omitempty" json:"deviceAuthUrl,omitempty"`
	// AuthURL is the authorization endpoint (used when Preset is empty).
	AuthURL string `msgpack:"authUrl,omitempty" json:"authUrl,omitempty"`
	// TokenURL is the token endpoint (used when Preset is empty).
	TokenURL string `msgpack:"tokenUrl,omitempty" json:"tokenUrl,omitempty"`
	// RevokeURL is the revocation endpoint (used when Preset is empty).
	RevokeURL string `msgpack:"revokeUrl,omitempty" json:"revokeUrl,omitempty"`
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
// ClientCredentials). It is IdP-agnostic: the plugin brings its own endpoint
// config and knows nothing about the host's internals.
type OAuthCapable interface {
	// GetOAuthMetadata returns the IdP display info, scope descriptions and
	// which flow sub-interfaces the plugin implements.
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
	// polling. Returns the awaiting-user state.
	StartDeviceFlow(scope []string) (*OAuthState, error)
	// CancelDeviceFlow aborts an in-progress device flow.
	CancelDeviceFlow() error
}

// OAuthAuthCodeFlowCapable is implemented by plugins that use the
// Authorization Code Flow with PKCE. The plugin builds the auth URL and keeps
// the PKCE verifier internal; the host opens the URL and forwards the IdP
// redirect's code+state to CompleteAuthCodeFlow.
type OAuthAuthCodeFlowCapable interface {
	OAuthCapable
	// StartAuthCodeFlow builds the authorization URL for the given scopes and
	// returns the awaiting-user state (AuthURL set).
	StartAuthCodeFlow(scope []string) (*OAuthState, error)
	// CompleteAuthCodeFlow exchanges the IdP-returned code for tokens after
	// validating state.
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
	// an initial token to validate them.
	ConfigureClientCredentials(clientID, clientSecret string) (*OAuthState, error)
}
