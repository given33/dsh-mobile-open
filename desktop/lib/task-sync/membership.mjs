// Resolve archive/pin/normal as one register. Persist its logical clock so a
// delayed packet cannot undo a newer local action, even after a restart.
export function checkMembership(value) {
  if (!value || !Number.isSafeInteger(value.clock) || value.clock < 1 || value.clock >= Number.MAX_SAFE_INTEGER ||
      !['desktop', 'cloud'].includes(value.actor) || !['normal', 'pinned', 'archived'].includes(value.state)) {
    throw Error('Invalid task membership revision');
  }
  return value;
}

export function readMembership(registry, id) {
  if (registry.archivedSessionIds.includes(id)) return 'archived';
  return registry.pinnedSessionIds?.includes(id) ? 'pinned' : 'normal';
}

export function isNewer(incoming, current) {
  return !current || incoming.clock > current.clock ||
    (incoming.clock === current.clock && incoming.actor > current.actor);
}

export async function setMembership(registry, id, state) {
  const current = readMembership(registry, id);
  if (current === state) return;
  if (state === 'archived') {
    await registry.archiveSession(id); // Native activity guard; never force-stop.
  } else {
    if (current === 'archived') await registry.unarchiveSession(id);
    if (state === 'pinned') await registry.pinSession(id);
    else if (current === 'pinned') await registry.unpinSession(id);
  }
}
