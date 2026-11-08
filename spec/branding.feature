Feature: Branding
  The site administrator customizes the wordmark, theme colors, and logo.
  Configz serves the active look without authentication.

  @branding/defaults @api
  Scenario: Unconfigured branding returns defaults
    Given no branding is configured
    When configz is requested
    Then default branding is returned

  @branding/stored-values @api
  Scenario: Stored branding is served
    Given stored branding values
    When configz is requested
    Then the stored values are returned

  @branding/custom-theme @api
  Scenario: Custom theme colors are served
    Given stored custom theme colors
    When configz is requested
    Then the custom theme values are returned

  @branding/save-text @api
  Scenario: Wordmark and powered-by settings are saved
    Given an admin with Pro
    When they save wordmark text and hide-powered-by
    Then the settings are persisted

  @branding/builtin-theme @api
  Scenario: A built-in theme can be selected
    Given an admin with Pro
    When they select a built-in theme
    Then the theme is saved

  @branding/save-custom-theme @api
  Scenario: Valid custom theme colors are saved
    Given an admin with Pro
    When they save valid custom colors
    Then the colors are persisted

  @branding/logo-upload @api
  Scenario: A logo is stored as a data URI
    Given an administrator with no public image storage
    When they upload a valid logo
    Then it is stored as a base64 data URI and returned unchanged

  @branding/favicon-upload @api
  Scenario: A favicon is stored as a data URI
    Given an admin with Pro
    When they upload a valid favicon
    Then it is stored as a base64 data URI carrying its mime type

  @branding/logo-mime @api
  Scenario: Logo type is validated
    Given an admin with Pro
    When they upload an invalid logo type
    Then the API responds 400

  @branding/logo-size @api
  Scenario: Logo size is limited
    Given an admin with Pro
    When they upload a logo larger than 256KB
    Then the API responds 413

  @branding/favicon-size @api
  Scenario: Favicon size is limited
    Given an admin with Pro
    When they upload a favicon larger than 64KB
    Then the API responds 413

  @branding/reset-field @api
  Scenario: A branding field can be reset
    Given stored branding
    When an admin resets a text field
    Then the field is cleared
