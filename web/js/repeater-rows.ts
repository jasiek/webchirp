// The one row builder for repeater directories: RepeaterRecord
// (web/js/repeater-record.ts) in, channel rows out, through the hooks
// buildRows() in web/js/ui/channel-table.ts hands a builder. Every directory
// normalizes into the record first, so the frequency pair, the tones, the
// mode and the comment are decided here once, whichever directory answered.
//
// buildRows() answers each write with the runtime's verdict and reruns the
// builder until it asks nothing new, so this has to stay a pure function of
// its input and the hooks: it never mutates a record and keeps no state.

import { formatCtcss, formatMhz } from "./repeater-record.ts";
import type { RepeaterMode, RepeaterRecord, RepeaterTone } from "./repeater-record.ts";
import { setHighestPower } from "./row-power.ts";
import type { RepeaterRowsResult, RowBuilderHooks, SkippedRepeater } from "./row-power.ts";
import type { ChannelRow } from "./ui/channel-values.ts";

// Analogue spellings, ranked. A narrow channel prefers the driver's narrow FM
// and still takes plain FM; a wide or unstated one prefers FM and still takes
// narrow, which can work a wide repeater at reduced deviation. "FMN", "N-FM",
// "Narrow" and "Wide" are not CHIRP mode names; they cost nothing and match a
// driver that ever spells one that way.
const NARROW_FM_CHOICES = ["NFM", "FMN", "Narrow", "N-FM", "FM"];
const FM_CHOICES = ["FM", "NFM", "FMN"];

// What each record mode has to become in the grid's Mode column, ranked: the
// first spelling the driver offers wins (findEnumOption). D-STAR is CHIRP's
// DV and Fusion its DN; the rest are spelled as the directories spell them.
// "other" has no entry: it is tried under the directory's own spelling.
const MODE_CHOICES: Readonly<Record<Exclude<RepeaterMode, "other">, readonly string[]>> = {
  FM: FM_CHOICES,
  NFM: NARROW_FM_CHOICES,
  "D-STAR": ["DV", "DSTAR", "D-STAR"],
  DMR: ["DMR", "MOTOTRBO"],
  Fusion: ["DN", "C4FM", "VW"],
  P25: ["P25", "APCO25", "APCO-25"],
  NXDN: ["NXDN"],
  M17: ["M17"],
  TETRA: ["TETRA"],
  ATV: ["ATV"],
};

/** What a query adds to the records it hands the builder. */
export interface RepeaterRowOptions {
  /**
   * The modes the query asked for, so a repeater that offers several is
   * written in the one the user searched for (a D-STAR search gets the DV
   * side of a mixed FM/D-STAR repeater, not its FM side).
   */
  preferredModes?: readonly RepeaterMode[];
}

// Resolve a record to a Mode the selected radio offers, or "" when none of its
// modes is one. A mode the query asked for wins over the record's own order;
// a record that carries none of them falls back to that order, because the
// filter, not the builder, decides what is in scope. No match is a skip, not
// a substitution: a D-STAR-only repeater written as NFM is a channel that
// cannot work the repeater whose callsign it carries.
function resolveMode(
  record: RepeaterRecord,
  findEnumOption: RowBuilderHooks["findEnumOption"],
  preferredModes: readonly RepeaterMode[],
): string {
  const asked = preferredModes.filter((mode, index) => record.modes.includes(mode)
    && preferredModes.indexOf(mode) === index);
  for (const mode of asked.length > 0 ? asked : record.modes) {
    const choices = mode === "other"
      ? (record.modeLabel ? [record.modeLabel] : [])
      : MODE_CHOICES[mode];
    const match = findEnumOption("Mode", choices, true);
    if (match) {
      return match;
    }
  }
  return "";
}

// A tone as the text applyTonePair writes: a CTCSS frequency, or "" for no
// tone. DCS is "" too: carrying a DCS code needs the DtcsCode/RxDtcsCode/
// DtcsPolarity columns, which no import writes yet (FINDINGS.md
// **rxf-ctcss-is-not-always-a-ctcss-frequency**), and writing it as a CTCSS
// tone would key a default tone the directory never mentioned.
function ctcssText(tone: RepeaterTone): string {
  return tone.kind === "ctcss" ? formatCtcss(tone.hz) : "";
}

// Write a normalized transmit/receive CTCSS pair into a row's tone columns.
//
// The mode is the part that matters: chirp_common.split_tone_encode reads
// rToneFreq only under "Tone", reads cToneFreq only under "TSQL", and reads
// both only under "Cross", so a tone written without the mode that encodes it
// is silently inert. The branches below mirror chirp_common.split_tone_decode,
// which is how CHIRP itself turns the same tx/rx pair back into a tmode, and
// each writes only the field its mode actually encodes.
//
// A radio whose valid_tmodes omit the mode a case calls for gets an explicit
// fallback rather than a half-written row, because valid_cross_modes stays
// fully populated even when has_cross is false - so the CrossMode options are
// no evidence that the radio can hold a split pair. The Tone column's own
// options are.
//
// Every tone is written before the mode that encodes it, and the mode is
// committed only once setRowValue reports the tone was accepted. The driver's
// tone table is an enum, and a rejected enum write is invisible: it leaves the
// column's first option behind, typically 67.0, so a directory tone the radio
// cannot produce would otherwise reach the grid as a plausible-looking tone
// under a committed tone mode - a channel that keys nothing (issue #104).
//
// Returns false when the repeater's *access* tone - the one the radio has to
// transmit for the repeater to open - could not be written, so the caller can
// leave the repeater out rather than insert a channel that can never work it.
// A receive-only tone that cannot be written costs the squelch and nothing
// else, so it returns true with the tone columns left alone.
export function applyTonePair(
  row: ChannelRow,
  { setRowValue, findEnumOption }: Pick<RowBuilderHooks, "setRowValue" | "findEnumOption">,
  transmitTone: string,
  receiveTone: string,
): boolean {
  const toneMode = (mode: string) => findEnumOption("Tone", [mode], true);
  const writeTransmitOnly = () => {
    const mode = toneMode("Tone");
    if (!mode || !setRowValue(row, "rToneFreq", transmitTone)) {
      return false;
    }
    setRowValue(row, "Tone", mode);
    return true;
  };
  const writeReceiveAsTsql = () => {
    const mode = toneMode("TSQL");
    if (!mode || !setRowValue(row, "cToneFreq", receiveTone)) {
      return false;
    }
    setRowValue(row, "Tone", mode);
    return true;
  };

  if (!transmitTone && !receiveTone) {
    return true;
  }
  if (transmitTone && !receiveTone) {
    return writeTransmitOnly();
  }
  if (transmitTone === receiveTone) {
    // Same tone both ways: TSQL transmits it and squelches on it. A radio
    // without TSQL - or one whose TSQL write does not take - still has to key
    // the repeater, so it keeps the transmit half rather than the row losing
    // the tone altogether.
    return writeReceiveAsTsql() || writeTransmitOnly();
  }

  // A split pair - including receive-only, which is a split with an empty
  // transmit half - is expressible only as Cross.
  const crossMode = toneMode("Cross");
  const crossValue = findEnumOption("CrossMode", [transmitTone ? "Tone->Tone" : "->Tone"], true);
  if (crossMode && crossValue) {
    // Both halves have to land before Cross is committed: a Cross row missing
    // one of them encodes the fallback tone on that side, which is worse than
    // falling back to the one side the radio can hold.
    const transmitOk = !transmitTone || setRowValue(row, "rToneFreq", transmitTone);
    if (transmitOk && setRowValue(row, "cToneFreq", receiveTone)) {
      setRowValue(row, "Tone", crossMode);
      setRowValue(row, "CrossMode", crossValue);
      return true;
    }
  }
  // Without Cross the row can hold one side, so keep the side that decides
  // whether the channel works at all. With a transmit tone that is the access
  // tone - drop it and the repeater never opens. With none, TSQL is the only
  // way to get the advertised receive squelch; it also transmits the tone,
  // which a repeater that asks for none ignores.
  if (transmitTone) {
    return writeTransmitOnly();
  }
  writeReceiveAsTsql();
  return true;
}

// The Comment column: where the repeater is, how far, and what the directory
// says about it. A distance taken from a locator box's centre is marked "~",
// because a 4-character square places a station within ~111 x 130 km and the
// row must not present that as measured.
function commentFor(record: RepeaterRecord): string {
  const distance = record.distanceKm === null
    ? ""
    : `${record.positionApproximate ? "~" : ""}${record.distanceKm.toFixed(1)} km`;
  return [record.locationName, record.positionLocator, distance, record.remarks, record.link]
    .map((part) => String(part || "").trim())
    .filter((part) => part.length > 0)
    .join(" | ");
}

// Turn records into channel rows for the selected radio. Returns
// `{ rows, skipped }`: a repeater the radio cannot express is left out rather
// than written as something it is not, and `skipped` says why, in the order
// the checks run, so a record that fails several is counted once:
//   - "frequency": setRowValue keeps the previous value when a frequency falls
//     outside the driver's valid_bands, and Offset is exempt from that check,
//     so a 70cm repeater on a 2m-only radio would otherwise reach the grid with
//     a blank Frequency and an accepted -7.6 MHz Offset -- and on upload a
//     blank Frequency reads as "erase this memory".
//   - "tone": the radio's tone table lacks the access tone, or it has no tone
//     mode at all, so the repeater could never be opened (`tone` carries the
//     frequency the directory published). Checked before the mode, as the
//     RXF builder this replaced did, so a record failing both is a tone skip.
//   - "mode": the radio offers none of the record's modes (`mode` carries the
//     directory's spelling when it gave one).
// Each row carries the driver's highest power tier: a repeater channel reaches
// for a distant machine (setHighestPower, web/js/row-power.ts).
export function buildRepeaterRows(
  records: readonly RepeaterRecord[],
  { createBlankRow, setRowValue, findEnumOption }: RowBuilderHooks,
  { preferredModes = [] }: RepeaterRowOptions = {},
): RepeaterRowsResult {
  const rows: ChannelRow[] = [];
  const skipped: SkippedRepeater[] = [];
  for (const record of records) {
    const name = String(record.name || "").trim();
    const row = createBlankRow();
    setRowValue(row, "Name", name);
    setRowValue(row, "Frequency", formatMhz(record.outputHz));
    if (!(Number.parseFloat(String(row.Frequency ?? "")) > 0)) {
      skipped.push({ repeater: name, reason: "frequency" });
      continue;
    }

    if (record.inputHz === null) {
      setRowValue(row, "Duplex", "");
      setRowValue(row, "Offset", "0.000000");
    } else {
      const deltaHz = record.inputHz - record.outputHz;
      setRowValue(row, "Duplex", deltaHz < 0 ? "-" : "+");
      setRowValue(row, "Offset", formatMhz(Math.abs(deltaHz)));
    }

    const transmitTone = ctcssText(record.inputTone);
    if (!applyTonePair(row, { setRowValue, findEnumOption }, transmitTone, ctcssText(record.outputTone))) {
      skipped.push({ repeater: name, reason: "tone", tone: transmitTone });
      continue;
    }

    const mode = resolveMode(record, findEnumOption, preferredModes);
    if (!mode) {
      skipped.push(record.modeLabel
        ? { repeater: name, reason: "mode", mode: record.modeLabel }
        : { repeater: name, reason: "mode" });
      continue;
    }
    setRowValue(row, "Mode", mode);
    setHighestPower(row, { setRowValue, findEnumOption });
    setRowValue(row, "Comment", commentFor(record));
    rows.push(row);
  }
  return { rows, skipped };
}
