/**
 * CJS stand-in for requireMailSession. The matters route still selects
 * the provider call and the thread ids; this only supplies the mailbox
 * owner the real helper would have resolved.
 */

let current = null;

function setMailSession(session) {
  current = session;
}

async function requireMailSession() {
  return current;
}

module.exports = { setMailSession, requireMailSession };
