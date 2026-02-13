// Test key-mapping logic
const pipe = (...fns) => (x) => fns.reduce((v, f) => f(v), x);

const groupKeysBySeparator = (keys) => {
  const groups = [];
  let current = [];
  for (const k of keys) {
    if (k === ",") {
      if (current.length > 0) groups.push(current);
      current = [];
    } else {
      current.push(k);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
};

const mapGroups = (groupMapper) => (groups) => groups.map(groupMapper);

const joinGroups = (innerSep, outerSep) => (groups) =>
  groups.map(g => g.join(innerSep)).join(outerSep);

const KEY_DISPLAY = {
  ctrl: "Ctrl", cmd: "Cmd", alt: "Alt", option: "Option", shift: "Shift",
  esc: "Esc", escape: "Esc", tab: "Tab", enter: "Enter", return: "Return",
  space: "Space", backspace: "Backspace", delete: "Delete",
  up: "\u2191", down: "\u2193", left: "\u2190", right: "\u2192",
};

const displayKey = (k) => {
  if (KEY_DISPLAY[k]) return KEY_DISPLAY[k];
  if (k.length === 1) return k.toUpperCase();
  if (k.startsWith("f") && !isNaN(k.slice(1))) return k.toUpperCase();
  return k;
};

const keysLabel = pipe(
  groupKeysBySeparator,
  mapGroups(group => group.map(displayKey)),
  joinGroups("+", ", ")
);

// Test case from the e2e test
const testKeys = ["ctrl", "c", ",", "ctrl", "c"];
console.log("Input keys:", testKeys);
console.log("Expected:", "Ctrl+C, Ctrl+C");

const result = keysLabel(testKeys);
console.log("Actual:", result);
console.log("Match:", result === "Ctrl+C, Ctrl+C");

// Debug intermediate steps
console.log("\n--- Debug Steps ---");
const step1 = groupKeysBySeparator(testKeys);
console.log("1. After groupKeysBySeparator:", JSON.stringify(step1));

const step2 = mapGroups(group => group.map(displayKey))(step1);
console.log("2. After mapGroups:", JSON.stringify(step2));

const step3 = joinGroups("+", ", ")(step2);
console.log("3. After joinGroups:", step3);
