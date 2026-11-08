Feature: Public redirects
  New direct-share links use a 12-character namespaced Base62 token. Historical
  ds_ links remain readable when an administrator chooses not to normalize
  stored data. Direct shares stream files through a presigned redirect.

  @redirect/direct-share @api
  Scenario: A valid direct-share link redirects to the file
    Given a valid direct-share token
    When the link is followed
    Then it 302-redirects with attachment disposition and no-store cache

  @redirect/unknown-ds-token @api
  Scenario: An unknown direct-share token is not found
    Given an unknown s-prefixed direct-share token
    When the link is followed
    Then the API responds 404
