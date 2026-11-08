Feature: Audit log
  The site administrator reviews a chronological, filterable and paginated
  audit log of site activity.

  @audit/actor-info @api
  Scenario: Events carry actor display info
    Given a recorded event
    When an admin reads the audit log
    Then each item includes the actor display info
