const mode = process.argv[2] ?? "hold";

if (mode === "stderr") {
  process.stderr.write("fixture stderr line\n");
  setTimeout(() => process.exit(0), 20);
} else if (mode === "exit") {
  setTimeout(() => process.exit(Number(process.argv[3] ?? 0)), 20);
} else {
  if (process.argv.includes("--ignore-term")) {
    process.on("SIGTERM", () => {});
  } else {
    process.on("SIGTERM", () => process.exit(0));
  }
  setInterval(() => {}, 1000);
}
