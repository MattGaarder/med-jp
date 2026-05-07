import { isMedicalDomain, parseDomains } from '../src/config/linguistics.js';

const tests = [
  { input: "medicine", expected: true },
  { input: "medicine, biology", expected: true },
  { input: "biology, medicine", expected: true },
  { input: "biology", expected: true },
  { input: "business", expected: false },
  { input: ["medicine", "finance"], expected: true },
  { input: "anatomy", expected: true },
  { input: "physiology", expected: true },
  { input: "genetics", expected: true },
  { input: "biochemistry", expected: true },
  { input: "surgery", expected: true },
  { input: "psychiatry", expected: true },
  { input: "med", expected: false }, // Should be false now
  { input: "pharm", expected: false }, // Should be false now
  { input: "medicine, business", expected: true },
  { input: null, expected: false },
  { input: "", expected: false }
];

console.log("Running Domain Parsing Tests...");
let passed = 0;

tests.forEach(({ input, expected }, index) => {
  const result = isMedicalDomain(input);
  const status = result === expected ? "✅ PASS" : "❌ FAIL";
  if (result === expected) passed++;
  console.log(`${status} [${index}] input: ${JSON.stringify(input)} | expected: ${expected} | result: ${result}`);
});

console.log(`\nTests passed: ${passed}/${tests.length}`);

if (passed === tests.length) {
  console.log("All domain parsing tests passed!");
} else {
  console.log("Some tests failed.");
  process.exit(1);
}
