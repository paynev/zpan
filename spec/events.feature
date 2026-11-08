Feature: Event stream
  The client subscribes to a single authenticated server-sent event stream that
  pushes background-job and notification updates, replacing per-resource polling.

  @events/stream @api
  Scenario: A browser session receives its multiplexed event stream
    Given an authenticated user
    When they open the global event stream
    Then job, notification, and download-task events are streamed to them

  @events/abort @api
  Scenario: Aborting the request closes the stream
    Given an open event stream
    When the request is aborted
    Then the stream is closed
