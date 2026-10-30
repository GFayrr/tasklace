// The path of a file that electron-vite copies next to the built main process, imported with the ?asset suffix.
declare module '*?asset' {
  const path: string;
  export default path;
}
