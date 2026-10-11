declare namespace PDFKit.Mixins {
  interface PDFVector {
    dash(lengths: readonly number[], options?: { readonly phase?: number }): this;
  }
}
