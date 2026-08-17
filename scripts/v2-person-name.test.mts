/**
 * Gate: show people as people.
 *
 * Triage listed raw addresses — "billing@definitivehc.com" tells you nothing
 * about who is asking. Names now come from the user's contacts, and Exchange
 * hands most corporate ones back as a directory sort key ("Yasavul, Sandra"),
 * which is not how anyone refers to a colleague.
 *
 * The flip must be conservative: credentials and generational suffixes are not
 * given names, and mangling someone's name is worse than leaving it alone.
 */
import assert from "node:assert/strict";
import { personName } from "../src/lib/v2/view/person-name.ts";

// THE CASE: a directory sort key becomes a name.
assert.equal(personName("Yasavul, Sandra"), "Sandra Yasavul");
assert.equal(personName("Sousa Gaspar, Raiane"), "Raiane Sousa Gaspar");
assert.equal(personName("Chronopoulos, John A"), "John A Chronopoulos");
assert.equal(personName("Wu, Lauren D."), "Lauren D. Wu");
assert.equal(personName("Hong, Ray  L"), "Ray  L Hong");

// Credentials are not first names — these must be left exactly as they are.
assert.equal(personName("Michael Samoszuk, M.D."), "Michael Samoszuk, M.D.");
assert.equal(personName("Varun Kapoor, MD"), "Varun Kapoor, MD");
assert.equal(personName("John Smith, Jr."), "John Smith, Jr.");
assert.equal(personName("Jane Doe, PhD"), "Jane Doe, PhD");
assert.equal(personName("Ann Lee, CPA"), "Ann Lee, CPA");

// Names with no comma pass through untouched.
assert.equal(personName("Sandy Paige"), "Sandy Paige");
assert.equal(personName("phillip haarhoff"), "phillip haarhoff");
assert.equal(personName("Christin Ungewiß"), "Christin Ungewiß");

// More than one comma is not a two-part name; leave it alone rather than guess.
assert.equal(
  personName("Kapoor, Varun, MD, MBA via LinkedIn"),
  "Kapoor, Varun, MD, MBA via LinkedIn",
);

// Company and system senders are untouched.
assert.equal(personName("LinkedIn News"), "LinkedIn News");
assert.equal(personName("TechnologyPark -  LaboratoryforSale.com"), "TechnologyPark -  LaboratoryforSale.com");

// An address is never rearranged, even if it somehow contains a comma.
assert.equal(personName("a,b@example.com"), "a,b@example.com");

// Empty and missing values are safe.
assert.equal(personName(""), "");
assert.equal(personName(null), "");
assert.equal(personName(undefined), "");
assert.equal(personName("  Yasavul, Sandra  "), "Sandra Yasavul");

// A dangling comma is not a name to flip.
assert.equal(personName("Yasavul,"), "Yasavul,");
assert.equal(personName(", Sandra"), ", Sandra");

console.log("v2-person-name: ok");
