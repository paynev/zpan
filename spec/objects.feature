Feature: Objects
  Files and folders ("matters") are the core entity. Creating a file returns
  size-decided upload instructions; the client PUTs each slice directly to S3,
  reads the ETags, and completes the upload. Clients browse/rename/move, soft-delete
  to trash and restore, permanently purge, and copy — with name-conflict
  resolution throughout.

  @objects/auth-required @api
  Scenario: Object access requires authentication
    Given an unauthenticated request
    When it calls the objects API
    Then the API responds 401

  @objects/list-empty @api
  Scenario: A new drive lists nothing
    Given a user with no objects
    When they list objects
    Then an empty list is returned

  @objects/create-invalid @api
  Scenario: Invalid create input is rejected
    Given invalid object input
    When it is posted
    Then the API responds 400

  @objects/create-no-storage @api
  Scenario: Creating a file needs a storage
    Given no storage is available
    When a file object is created
    Then the API responds 500

  @objects/create-file-presign @api
  Scenario: Creating a file returns upload instructions
    Given a configured storage
    When a file object is created
    Then a draft with upload instructions (part size + presigned URLs) is returned

  @objects/detail-missing @api
  Scenario: A missing object detail is 404
    Given a missing object id
    When its detail is requested
    Then the API responds 404

  @objects/complete-upload @api
  Scenario: An upload is completed
    Given a draft object whose slices were uploaded to S3
    When the upload is completed with the part ETags
    Then the object becomes live

  @objects/abort-upload @api
  Scenario: An upload is aborted
    Given a draft object with an open upload session
    When the upload is aborted
    Then the draft is discarded and its S3 upload is cleaned up

  @objects/trash @api
  Scenario: A file is soft-deleted to trash
    Given a live file
    When it is deleted
    Then it moves to trash (trashedAt is set)

  @objects/restore @api
  Scenario: A trashed file is restored
    Given a trashed file
    When it is restored
    Then it becomes active again

  @objects/list-trashed @api
  Scenario: Trashed roots list under their active parents
    Given trashed objects under active parents
    When trashed objects are listed
    Then trashed folder roots are returned nested under active parents

  @objects/purge-file-s3 @api
  Scenario: Purging a trashed file cleans up S3
    Given a trashed file
    When it is permanently deleted
    Then it is removed and its S3 object deleted
