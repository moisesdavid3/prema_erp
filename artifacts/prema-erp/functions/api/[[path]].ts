import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import app from "../../../api-server/src/app";
import { createDbConnection, dbContext } from "../../../../lib/db/src/index";

type ExpressRes = {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[]>;
};

async function createReq(request: Request, url: URL): Promise<any> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : (await request.text());

  const stream = Readable.from(body !== null ? [Buffer.from(body, "utf8")] : []) as any;
  stream.method = request.method;
  stream.url = url.pathname + url.search;
  stream.originalUrl = url.pathname + url.search;
  stream.headers = headers;
  stream.rawHeaders = [];
  stream.trailers = {};
  stream.rawTrailers = [];
  stream.aborted = false;
  stream.complete = false;
  stream.httpVersion = "1.1";
  stream.httpVersionMajor = 1;
  stream.httpVersionMinor = 1;
  stream.query = Object.fromEntries(url.searchParams);
  stream.on("end", () => {
    stream.complete = true;
    stream.readable = false;
  });
  const socket = new EventEmitter();
  Object.assign(socket, {
    remoteAddress: "::1",
    remotePort: 0,
    encrypted: false,
    readable: true,
    writable: true,
    destroyed: false,
    setTimeout: () => socket,
    setNoDelay: () => socket,
    setKeepAlive: () => socket,
    destroy: () => socket,
    write: () => true,
    end: () => socket,
    resume: () => socket,
    pause: () => socket,
  });
  stream.connection = socket;
  stream.socket = socket;
  return stream;
}

function createRes(): any {
  const headers = new Map<string, string | string[]>();
  const emitter = new EventEmitter();
  const body: Buffer[] = [];

  const res: any = emitter;
  res.statusCode = 200;
  res.statusMessage = "";
  res.headersSent = false;
  res.writableEnded = false;
  res.finished = false;
  res.sendDate = false;
  res.useChunkedEncodingByDefault = false;
  res.chunkedEncoding = false;

  res.setHeader = (key: string, value: string | string[]) => {
    headers.set(String(key).toLowerCase(), value);
  };
  res.getHeader = (key: string) => headers.get(String(key).toLowerCase());
  res.getHeaders = () => Object.fromEntries(headers);
  res.getHeaderNames = () => [...headers.keys()];
  res.hasHeader = (key: string) => headers.has(String(key).toLowerCase());
  res.removeHeader = (key: string) => {
    headers.delete(String(key).toLowerCase());
  };
  res.writeHead = (
    status: number,
    reasonOrHeaders?: string | Record<string, unknown>,
    obj?: Record<string, unknown>,
  ) => {
    let headersToSet = obj;
    if (typeof reasonOrHeaders === "object" && reasonOrHeaders !== null) {
      headersToSet = reasonOrHeaders;
    }
    res.statusCode = status;
    if (headersToSet) {
      for (const [k, v] of Object.entries(headersToSet)) {
        res.setHeader(k, v as string);
      }
    }
    res.headersSent = true;
  };
  res.write = (chunk: unknown) => {
    body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  };
  res.end = (chunk?: unknown) => {
    if (chunk !== undefined && chunk !== null && chunk !== "") {
      body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    res.writableEnded = true;
    res.finished = true;
    res.headersSent = true;
    res.body = Buffer.concat(body).toString("utf8");
    emitter.emit("finish");
    emitter.emit("close");
  };
  res.setTimeout = () => res;
  res.flushHeaders = () => {};
  res.assignSocket = () => {};
  res.detachSocket = () => {};
  return res;
}

export const onRequest: PagesFunction = async ({ request }) => {
  const url = new URL(request.url);
  const req = await createReq(request, url);
  const res = createRes();
  res.socket = req.socket;

  const { sql, db } = createDbConnection();
  try {
    await dbContext.run(db, () =>
      new Promise<void>((resolve, reject) => {
        res.once("finish", () => resolve());
        app(req, res, (err: unknown) => (err ? reject(err) : resolve()));
      }),
    );
  } finally {
    await sql.end().catch(() => {});
  }

  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(res.getHeaders())) {
    if (Array.isArray(value)) {
      for (const item of value) responseHeaders.append(key, item);
    } else if (value !== undefined) {
      responseHeaders.set(key, String(value));
    }
  }

  const expressRes: ExpressRes = {
    statusCode: res.statusCode,
    body: res.body ?? "",
    headers: res.getHeaders(),
  };

  return new Response(expressRes.body, {
    status: expressRes.statusCode,
    headers: responseHeaders,
  });
};
