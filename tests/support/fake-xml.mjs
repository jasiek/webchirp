// A DOMParser stand-in for the RXF fixtures the repeater tests feed through
// web/js/rxf.js. The real parser runs on the browser's DOMParser, which node
// has not got; this answers the handful of selectors web/js/datasources.js and
// web/js/callsign-lookup.js actually ask for, so transport, parsing and row
// construction can be exercised as one flow headless.
//
// Shared by the query-modal tests and the hover-map tests, so the two cannot
// disagree about what a fixture means.

export class FakeXmlDocument {
  constructor(xmlText = "") {
    this.xmlText = String(xmlText);
  }

  textOf(tagName) {
    const match = this.xmlText.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, "i"));
    return match?.[1]?.trim();
  }

  attributedText(tagName, type) {
    const pattern = new RegExp(`<${tagName}[^>]*type=["']${type}["'][^>]*>([\\s\\S]*?)</${tagName}>`, "i");
    return this.xmlText.match(pattern)?.[1]?.trim();
  }

  querySelector(selector) {
    if (selector === "rxf > perspective") {
      const textContent = this.textOf("perspective");
      return textContent === undefined ? null : { textContent };
    }
    return null;
  }

  // Each <repeater> is scoped to its own document, so a response carrying more
  // than one does not have every field answered from the first.
  repeaterDocs() {
    return (this.xmlText.match(/<repeater>[\s\S]*?<\/repeater>/gi) || [])
      .map((block) => new FakeXmlDocument(block));
  }

  querySelectorAll(selector) {
    if (selector === "repeaters > repeater > country") {
      return this.repeaterDocs()
        .map((doc) => doc.textOf("country"))
        .filter((textContent) => textContent !== undefined)
        .map((textContent) => ({ textContent }));
    }
    if (selector === "repeaters > repeater") {
      return this.repeaterDocs().map((doc) => {
        const values = new Map([
          ["qra", doc.textOf("qra")],
          ["mode", doc.textOf("mode")],
          ['qrg[type="rx"]', doc.attributedText("qrg", "rx")],
          ['qrg[type="tx"]', doc.attributedText("qrg", "tx")],
          ["qth", doc.textOf("qth")],
          ["remarks", doc.textOf("remarks")],
          ["link", doc.textOf("link")],
          ['ctcss[type="rx"]', doc.attributedText("ctcss", "rx")],
          ['ctcss[type="tx"]', doc.attributedText("ctcss", "tx")],
          ["location > latitude", doc.textOf("latitude")],
          ["location > longitude", doc.textOf("longitude")],
        ]);
        return {
          querySelector: (childSelector) => {
            const textContent = values.get(String(childSelector));
            return textContent === undefined ? null : { textContent };
          },
        };
      });
    }
    return [];
  }
}

// The globals option installFakeDom takes, so a test that parses RXF installs
// the stand-in the same way in every suite.
export function fakeXmlGlobals() {
  return {
    DOMParser: class {
      parseFromString(xmlText) {
        return new FakeXmlDocument(xmlText);
      }
    },
  };
}
