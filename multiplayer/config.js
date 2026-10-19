/*
 * PolyTrack multiplayer - runtime configuration.
 *
 * ablyKey: capability key from your Ably app. Leave it empty to play over
 *          same-browser tabs only (BroadcastChannel, no signup, no internet).
 *          Scope the key to publish/subscribe on `polytrack-mp:*`.
 *
 * maxPlayers: room cap. 16 matches PolyTrack 0.6.0's multiplayer limit.
 */
window.POLYTRACK_MP_CONFIG = {
  ablyKey: "",
  maxPlayers: 16,
  enabled: true,

  // The reference menu labels car customisation "Garage". Set to false to keep
  // the original "Customize" wording.
  renameGarageTile: true,

  // Profiles are managed from the Garage ("Switch Profile") in the reference
  // layout, so the home-screen Profile tile is hidden but kept in the DOM.
  hideProfileTile: true,
};
