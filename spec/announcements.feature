Feature: Announcements
  The site administrator publishes announcements; users read the active ones.

  @announcements/crud @api
  Scenario: Admins create, list, update and delete announcements
    Given an authenticated administrator
    When they create, list, update and delete an announcement
    Then each operation succeeds

  @announcements/user-active @api
  Scenario: Users see active announcements
    Given published announcements
    When a user lists announcements with scope active
    Then only published announcements are returned
