import { WHITEBOARD_CATALOG } from "./domains";
import type {
  WhiteboardItem,
  WhiteboardItemStatus,
  WhiteboardSection,
  WhiteboardView,
} from "./types";

export type WhiteboardSeedRow = {
  externalKey: string;
  section: string;
  title: string;
  status?: WhiteboardItemStatus;
  ownerLabel?: string | null;
  priority?: number;
};

/**
 * Conall's CEO Whiteboard — Oct 30, 2026. Idempotent on `external_key`.
 * Titles are his words from the OneNote page, one line each.
 */
export const WHITEBOARD_SEED_ITEMS: readonly WhiteboardSeedRow[] = [
  { externalKey: "W001", section: "due-now", title: "Aspect / David Paul: Q3 TTM financials, due 10/30 (needs Ganesh's Q4-25 GAAP rev/EBITDA; cash $600K, debt $0)", priority: 10 },
  { externalKey: "W002", section: "due-now", title: "Day10: send feedback + start date (prefer 11/9), due 10/30", priority: 20 },
  { externalKey: "W003", section: "due-now", title: "Biomeme: confirm 11/1 payment lands; decide Q4 bad-debt reserve (~$540K open, $431K overdue since 8/22)", priority: 30 },
  { externalKey: "W004", section: "due-now", title: "Parallel / Clint: contracts, CO example, cash + GAAP models (11/2)", priority: 40 },
  { externalKey: "W005", section: "due-now", title: "GW Biosolutions: 5 RFQs, quote or pass (11/2)", priority: 50 },
  { externalKey: "W006", section: "due-now", title: "Siemens / Natalie: 110 elevated-AAG serum quote (11/3)", priority: 60 },
  { externalKey: "W007", section: "due-now", title: "Pacifica Unit 214: renewal decision by ~11/5 (counter month-to-month or 12 mo)", priority: 70 },
  { externalKey: "W008", section: "due-now", title: "AMH / Dylan: send $657,510 budget, decide milestone split + remote SDV (11/5)", priority: 80 },
  { externalKey: "W009", section: "due-now", title: "Roche PSA (84 male donors): quote + enrollment forecast (~11/6)", priority: 90 },
  { externalKey: "W010", section: "due-now", title: "Hep C ADD_2949 / Ebony: send 18-mo payment schedule ($3.63M)", priority: 100 },
  { externalKey: "W011", section: "due-now", title: "Advarra IRB RCD_2859: confirm continuing review filed (approval expired 10/24)", priority: 110 },
  { externalKey: "W012", section: "due-now", title: "Gusto: PA Q3 filing rejected (due 10/31); MA account inactive", priority: 120 },
  { externalKey: "W013", section: "due-now", title: "Qualio: approve CAPA-14 (waiting since 10/23) and QMP-16", priority: 130 },
  { externalKey: "W014", section: "due-now", title: "Mgmt Liability: Anthony's application, verify Indio 11/6 date (renews 1/24/27)", priority: 140 },

  { externalKey: "W015", section: "cash-lender", title: "Weekly cash vs. 13-week forecast", priority: 10 },
  { externalKey: "W016", section: "cash-lender", title: "Weekly AR over 30 days check", priority: 20 },
  { externalKey: "W017", section: "cash-lender", title: "Roche: send INV 10665 ($47,985) + PO extension; fix INV 10693 ($98,800) PO; bill ~$400K unbilled; Albany closeout", priority: 30 },
  { externalKey: "W018", section: "cash-lender", title: "Emory RCD_2818: confirm payout (start-up fee vs $15.5K), send termination letter v2", priority: 40 },
  { externalKey: "W019", section: "cash-lender", title: "Approve: Definitive INV64592 ($18,231, due 11/28), BILL backlog, Erick off-cycle payroll", priority: 50 },

  { externalKey: "W020", section: "sales-marketing", title: "Marketing firm / agent: LinkedIn + case studies → Tiffany (open letter)", priority: 10 },
  { externalKey: "W021", section: "sales-marketing", title: "Set marketing goals", priority: 20 },
  { externalKey: "W022", section: "sales-marketing", title: "ADLM + AMP (11/10-14, booth #1800) follow-ups", priority: 30 },
  { externalKey: "W023", section: "sales-marketing", title: "Review quotes: Toxo/CMV ($1.06M), Ortho ($45/sample + $2,500), Revvity DMD (~$493K), Thermo c503 rank, HIV donors (due 10/30)", priority: 40 },
  { externalKey: "W024", section: "sales-marketing", title: "CMV: follow up with contacted sites (Nov–Jan window)", priority: 50 },
  { externalKey: "W025", section: "sales-marketing", title: "Roche c503: restate dev channel use (Emelia)", priority: 60 },
  { externalKey: "W026", section: "sales-marketing", title: "Abbott 2026P-186 (Ajda)", priority: 70 },
  { externalKey: "W027", section: "sales-marketing", title: "SCORR: pick 11/4 post replacement, career video, Rich blog", priority: 80 },
  { externalKey: "W028", section: "sales-marketing", title: "Expert finders deck: slide 6 prices, trial count, logo", priority: 90 },
  { externalKey: "W029", section: "sales-marketing", title: "Client phone gifts (31): waiting on SCORR addresses", priority: 100 },
  { externalKey: "W030", section: "sales-marketing", title: "Open letter → Rob Thomas", priority: 110 },

  { externalKey: "W031", section: "board", title: "Investor letter → Q3 (draft to board 11/11, out 11/13)", priority: 10 },
  { externalKey: "W032", section: "board", title: "Board referrals: RDI Operator; 17 intro drafts need new deadline", priority: 20 },
  { externalKey: "W033", section: "board", title: "Minutes for 10/28 meeting (no owner)", priority: 30 },
  { externalKey: "W034", section: "board", title: "Next: 11/17 1 PM (materials 11/16 5 PM); 12/16 1 PM Zoom", priority: 40 },
  { externalKey: "W035", section: "board", title: "Decide growth target (25%/yr vs hold $10-12M)", priority: 50 },
  { externalKey: "W036", section: "board", title: "Top accounts line: Abbott, Danaher, Applied BioCode, Roche, Biomeme", priority: 60 },

  { externalKey: "W037", section: "ops", title: "2850 catch-up: V2 change order to Roche, local IRB outcome", ownerLabel: "Lara", priority: 10 },
  { externalKey: "W038", section: "ops", title: "Roche stability v2 protocol", ownerLabel: "Lara", priority: 20 },
  { externalKey: "W039", section: "ops", title: "AMH kickoff (weekly Friday call); site lock", ownerLabel: "Lara", priority: 30 },
  { externalKey: "W040", section: "ops", title: "BEC_2798 CO2 signed 10/21 → file PDF; confirm SIV", ownerLabel: "Lara", priority: 40 },
  { externalKey: "W041", section: "ops", title: "TriCore / ABC-301: EDC question; CSA + proposal to Jesse", ownerLabel: "Lara", priority: 50 },
  { externalKey: "W042", section: "ops", title: "Owners for RCD_2904 closeout + LMD_2691 (post-Claire)", ownerLabel: "Lara", priority: 60 },
  { externalKey: "W043", section: "ops", title: "Eurofins ID-ENTITY updates; Allen CTA unsigned", ownerLabel: "Lara", priority: 70 },
  { externalKey: "W044", section: "ops", title: "Protocol sessions with Lara for study team", ownerLabel: "Lara", priority: 80 },
  { externalKey: "W045", section: "ops", title: "Advarra IRB-to-CTMS agent, update Jesse Meaux", ownerLabel: "Lara", priority: 90 },
  { externalKey: "W046", section: "ops", title: "Applied BioCode supplier survey (6 questions), CLIA cert copy", ownerLabel: "Lara", priority: 100 },
  { externalKey: "W047", section: "ops", title: "Liisa's SOPs + consent doc (due 10/30)", ownerLabel: "Lara", priority: 110 },

  { externalKey: "W048", section: "company-future", title: "CAP: patient testing evidence by 1/15/27", priority: 10 },
  { externalKey: "W049", section: "company-future", title: "Lab director + CLIA/CAP plan: Workable job live (15 prospects); decide Amit Ghoshal", priority: 20 },
  { externalKey: "W050", section: "company-future", title: "Ferdinand: decide (paid 1-week trial)", priority: 30 },
  { externalKey: "W051", section: "company-future", title: "Micah Grossman: references / next step", priority: 40 },
  { externalKey: "W052", section: "company-future", title: "Day10 pilot: 2-week trial, Part 11 plan, price", priority: 50 },
  { externalKey: "W053", section: "company-future", title: "Finance: Senior Accountant via Kaptan; Parallel pilot", priority: 60 },
  { externalKey: "W054", section: "company-future", title: "RDI Operator pipeline: 17 stale + Amy Yang decision", priority: 70 },
  { externalKey: "W055", section: "company-future", title: "Siemens CRO; CSUN lab tech (March/April)", priority: 80 },
  { externalKey: "W056", section: "company-future", title: "Lara + Irina chat", priority: 90 },

  { externalKey: "W057", section: "contracts", title: "Abbott: MSA draft, ADD_2931 LOI, detailed SOW", priority: 10 },
  { externalKey: "W058", section: "contracts", title: "US Fertility CTA to Tasha (overdue 10/24)", priority: 20 },
  { externalKey: "W059", section: "contracts", title: "Kaptan Samoi amendment", priority: 30 },
  { externalKey: "W060", section: "contracts", title: "miRoncol MOU: sign after Amy's review", priority: 40 },
  { externalKey: "W061", section: "contracts", title: "Ganesh: contracts 300k/2931/2932, 490 closure costs, portal access", priority: 50 },
  { externalKey: "W062", section: "contracts", title: "Verify: Rubrum SOW, Roche/Ventana MSA, Thermo CDA", priority: 60 },

  { externalKey: "W063", section: "security", title: "Rotate Nyquist password (sent in Teams 10/21)", priority: 10 },
  { externalKey: "W064", section: "security", title: "Warn staff on phishing spoofing conall@", priority: 20 },

  { externalKey: "W065", section: "relationships", title: "Dash.bio, Sandeep, Eric Feinstein, Eliad (YouTube links, lab tour)", priority: 10 },
  { externalKey: "W066", section: "relationships", title: "Duchenne materials to Jordan Elder (due 10/30); Omai BioFire; Carly/Vanessa 2027", priority: 20 },

  { externalKey: "W067", section: "done", title: "BD strategy", status: "done", priority: 10 },
  { externalKey: "W068", section: "done", title: "Biomeme payment plan", status: "done", priority: 20 },
  { externalKey: "W069", section: "done", title: "Abbott body fluids", status: "done", priority: 30 },
  { externalKey: "W070", section: "done", title: "Eurofins scope", status: "done", priority: 40 },
  { externalKey: "W071", section: "done", title: "PM / data / proposal hires", status: "done", priority: 50 },
  { externalKey: "W072", section: "done", title: "ABC reprice", status: "done", priority: 60 },
  { externalKey: "W073", section: "done", title: "AMH feasibility", status: "done", priority: 70 },
  { externalKey: "W074", section: "done", title: "Controller / engineer decision", status: "done", priority: 80 },
  { externalKey: "W075", section: "done", title: "AVB cert", status: "done", priority: 90 },
  { externalKey: "W076", section: "done", title: "Primex paid", status: "done", priority: 100 },
  { externalKey: "W077", section: "done", title: "Parallel NDA", status: "done", priority: 110 },
  { externalKey: "W078", section: "done", title: "APB_2928 CO1", status: "done", priority: 120 },
  { externalKey: "W079", section: "done", title: "Board materials", status: "done", priority: 130 },
];

const SEED_AS_OF = "2026-10-30T16:14:00.000Z";

export function seedItemId(externalKey: string): string {
  return `seed-item-${externalKey}`;
}

export function seedSectionId(slug: string): string {
  return `seed-section-${slug}`;
}

export function seedWhiteboardView(accountId = "seed"): WhiteboardView {
  const sections: WhiteboardSection[] = WHITEBOARD_CATALOG.map((entry) => {
    const sectionId = seedSectionId(entry.slug);
    const items: WhiteboardItem[] = WHITEBOARD_SEED_ITEMS.filter(
      (row) => row.section === entry.slug,
    ).map((row) => ({
      id: seedItemId(row.externalKey),
      accountId,
      sectionId,
      sectionSlug: entry.slug,
      externalKey: row.externalKey,
      title: row.title,
      body: null,
      status: row.status ?? "open",
      priority: row.priority ?? 100,
      dueAt: null,
      ownerLabel: row.ownerLabel ?? null,
      conversationId: null,
      matterId: null,
      botTaskId: null,
      source: "user",
      createdAt: SEED_AS_OF,
      updatedAt: SEED_AS_OF,
    }));
    return {
      id: sectionId,
      slug: entry.slug,
      title: entry.title,
      subtitle: entry.subtitle,
      sortOrder: entry.sortOrder,
      items,
    };
  });
  return {
    asOf: SEED_AS_OF,
    persisted: false,
    seeded: true,
    sections,
  };
}
