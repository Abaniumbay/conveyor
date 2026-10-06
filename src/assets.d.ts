// Files embedded with `import ... with { type: "text" }` or `{ type: "file" }`: the module's default
// export is the file's text, or the path to read it from (inside the compiled executable too).
declare module "*.md" {
  const text: string;
  export default text;
}
