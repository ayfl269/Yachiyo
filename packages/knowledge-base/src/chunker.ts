export interface ChunkerConfig {
  chunkSize: number;
  chunkOverlap: number;
  separator: string;
}

const DEFAULT_CHUNKER_CONFIG: ChunkerConfig = {
  chunkSize: 500,
  chunkOverlap: 50,
  separator: "\n\n",
};

export class TextChunker {
  private config: ChunkerConfig;

  constructor(config?: Partial<ChunkerConfig>) {
    this.config = { ...DEFAULT_CHUNKER_CONFIG, ...config };
  }

  chunk(text: string): string[] {
    const { chunkSize, chunkOverlap, separator } = this.config;
    const paragraphs = text.split(separator);
    const chunks: string[] = [];
    let currentChunk = "";
    let overlapTail = "";

    for (const paragraph of paragraphs) {
      if (paragraph.length === 0) continue;

      // If the paragraph itself exceeds chunkSize, hard-split it
      const subPieces = this.hardSplit(paragraph, chunkSize);

      for (const piece of subPieces) {
        const candidate = currentChunk
          ? currentChunk + separator + piece
          : overlapTail + piece;

        if (candidate.length > chunkSize && currentChunk.length > 0) {
          // Finalize current chunk
          chunks.push(currentChunk);
          // Save overlap tail from current chunk
          overlapTail = this.getOverlapTail(currentChunk, chunkOverlap);
          // Start new chunk with overlap
          currentChunk = overlapTail + piece;
        } else {
          currentChunk = candidate;
        }
      }
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  private hardSplit(text: string, chunkSize: number): string[] {
    if (text.length <= chunkSize) return [text];
    const pieces: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      pieces.push(text.slice(i, i + chunkSize));
    }
    return pieces;
  }

  private getOverlapTail(text: string, overlapSize: number): string {
    // overlapSize <= 0 时无重叠，返回空串；text 短于 overlapSize 时全部作为重叠尾部
    if (overlapSize <= 0) return "";
    if (text.length <= overlapSize) return text;
    return text.slice(-overlapSize);
  }
}
