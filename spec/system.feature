Feature: Site configuration
  The frontend reads one safe structured configuration document while admins
  edit fixed groups of site settings through dedicated endpoints.

  @system/public-config @api
  Scenario: Public site configuration has a stable safe structure
    Given an anonymous visitor
    When they request configz
    Then site identity, branding, effective auth settings, and service URLs are returned without secrets

  @system/instance-info-admin-only @api
  Scenario: Instance info is admin-only
    Given the instance-info endpoint
    When a non-admin requests it
    Then access is denied

  @system/changelog-admin-only @api
  Scenario: Release version and changelog are admin-only
    Given the changelog endpoint
    When a non-admin requests it
    Then access is denied
