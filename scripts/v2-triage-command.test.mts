/**
 * Gate: Triage can never delete a conversation the server did not authorize.
 *
 * The restored table has bulk actions. "Delete these" runs over a whole
 * section, and the sections that are not "Safe to delete" hold rows the safety
 * layer vetoed. If a bulk delete escalated those, one click would destroy
 * exactly the mail the veto exists to protect.
 *
 * Deletion is authorized solely by the signed token the server minted for that
 * decision. No token means archive.
 */
import assert from "node:assert/strict";
import { commandFor } from "../src/components/v2/triage-command.ts";

// A server-authorized row deletes, carrying its token through untouched.
{
  const command = commandFor({ conversationId: "c1", deleteToken: "tok" }, "trash");
  assert.equal(command.type, "delete");
  assert.deepEqual(command, {
    type: "delete",
    conversationId: "c1",
    deleteToken: "tok",
  });
}

// THE CASE: asking to delete a row with no token archives it instead.
{
  const command = commandFor({ conversationId: "c2" }, "trash");
  assert.equal(
    command.type,
    "archive",
    "a row with no delete token must never produce a delete command",
  );
}

// An empty-string token is not authorization either.
{
  const command = commandFor({ conversationId: "c3", deleteToken: "" }, "trash");
  assert.equal(command.type, "archive", "an empty token must not authorize a delete");
}

// Archive is archive, even for a row that could have been deleted.
{
  const command = commandFor({ conversationId: "c4", deleteToken: "tok" }, "archive");
  assert.equal(command.type, "archive");
}

// A mixed bulk selection: only the authorized rows are deleted.
{
  const rows = [
    { conversationId: "a", deleteToken: "tok-a" },
    { conversationId: "b" },
    { conversationId: "c", deleteToken: "tok-c" },
  ];
  const commands = rows.map((r) => commandFor(r, "trash"));
  assert.deepEqual(
    commands.map((c) => `${c.type}:${c.conversationId}`),
    ["delete:a", "archive:b", "delete:c"],
    "a mixed bulk delete must delete only what the server authorized",
  );
}

console.log("v2-triage-command: ok");
