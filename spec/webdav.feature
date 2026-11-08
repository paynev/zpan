Feature: WebDAV
  Users mount their drive over WebDAV (Class 2) using an API key via Basic Auth.
  The endpoint speaks PROPFIND/PROPPATCH/GET/PUT/MKCOL/MOVE/COPY/DELETE/LOCK/UNLOCK,
  scoped to the administrator's own drive, with WebDAV lock support.

  @webdav/auth @api
  Scenario: WebDAV requires a valid API key
    Given missing or insufficient API keys and a session cookie
    When a WebDAV request is made
    Then it is rejected and the session cookie is not accepted

  @webdav/put-create @api
  Scenario: PUT creates a file
    Given a writable path
    When PUT writes bytes
    Then a file matter is created through the configured storage

  @webdav/put-update @api
  Scenario: PUT updates a file and rejects collection writes
    Given an existing file and a collection
    When PUT targets each
    Then the file is updated and the collection write is rejected

  @webdav/put-rollback @api
  Scenario: A failed PUT rolls back its write
    Given a storage write that fails
    When PUT is attempted
    Then the partially written object and matter are rolled back

  @webdav/mkcol @api
  Scenario: MKCOL creates a folder
    Given a writable parent
    When MKCOL is issued
    Then a folder matter is created

  @webdav/mkcol-guards @api
  Scenario: MKCOL guards existing targets and missing parents
    Given an existing target or a missing parent
    When MKCOL is issued
    Then it is rejected

  @webdav/copy-recursive @api
  Scenario: COPY recurses and rejects copying into a descendant
    Given a collection
    When COPY is issued
    Then it copies recursively and rejects copying into its own descendant

  @webdav/move-descendants @api
  Scenario: MOVE keeps descendant paths consistent
    Given a collection
    When MOVE is issued
    Then descendant paths stay consistent and descendant moves are rejected

  @webdav/move-overwrite @api
  Scenario: MOVE honors the Overwrite header
    Given an existing destination
    When MOVE is issued with Overwrite
    Then the header is honored

  @webdav/copy-rollback @api
  Scenario: A failed COPY rolls back its writes
    Given a storage copy that fails
    When COPY is attempted
    Then the created rows and copied object are rolled back

  @webdav/lock-preconditions @api
  Scenario: Write methods enforce If and lock preconditions
    Given a locked resource
    When a write method is issued
    Then If and lock preconditions are enforced before mutation

  @webdav/lock-unlock @api
  Scenario: LOCK and UNLOCK manage Class 2 locks
    Given a resource
    When LOCK and UNLOCK are issued
    Then Class 2 lock state is exposed and write tokens enforced

  @webdav/path-validation @api
  Scenario: Malformed paths are rejected
    Given a path with traversal, empty segments, or encoded separators
    When any method is issued
    Then it is rejected
