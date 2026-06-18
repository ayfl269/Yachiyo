declare module "archiver" {
  import { Transform } from "stream";
  interface ArchiverOptions {
    zlib?: { level?: number };
  }
  interface Archiver extends Transform {
    pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream;
    directory(dirpath: string, destpath: string | false): this;
    finalize(): Promise<void>;
  }
  function archiver(format: string, options?: ArchiverOptions): Archiver;
  export = archiver;
}
