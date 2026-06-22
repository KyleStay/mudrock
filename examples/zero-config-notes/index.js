const encoder = new TextEncoder();

async function json(request) {
  if (!request.body) {
    return {};
  }

  return request.json();
}

function jsonResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

async function readStorageObject(object) {
  if (!object) {
    return null;
  }

  const bytes = await object.arrayBuffer();
  return new TextDecoder().decode(bytes);
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const notes = Mudrock.db("notes");
    const files = Mudrock.storage("attachments");
    const user = await Mudrock.auth.currentUser(request);

    if (url.pathname === "/notes" && request.method === "POST") {
      const body = await json(request);
      const id = body.id || crypto.randomUUID();
      const value = {
        id,
        title: String(body.title || "Untitled"),
        body: String(body.body || ""),
        owner: user ? user.id : "anonymous",
        updated_at: new Date().toISOString()
      };

      const receipt = await notes.put(`note:${id}`, value);
      return jsonResponse({ note: value, receipt }, { status: 201 });
    }

    if (url.pathname === "/notes" && request.method === "GET") {
      const rows = await notes.list({ prefix: "note:" });
      return jsonResponse({
        notes: rows.map((row) => row.value),
        sync: {
          primitive: "notes",
          href: "/__mudrock/sync?primitive=notes"
        }
      });
    }

    if (url.pathname === "/attachments" && request.method === "POST") {
      const noteId = url.searchParams.get("note_id") || "draft";
      const key = `attachment:${noteId}`;
      const object = await files.put(key, request.body || encoder.encode(""));
      await notes.patch(`note:${noteId}`, { attachment: object });
      return jsonResponse({ attachment: object }, { status: 201 });
    }

    if (url.pathname === "/attachments" && request.method === "GET") {
      const noteId = url.searchParams.get("note_id") || "draft";
      const object = await files.get(`attachment:${noteId}`);
      return jsonResponse({
        note_id: noteId,
        text: await readStorageObject(object),
        object
      });
    }

    if (url.pathname === "/session") {
      return jsonResponse({
        user,
        sign_in: "/__mudrock/auth/start?provider=github&redirect_path=/session"
      });
    }

    if (url.pathname === "/limits") {
      return jsonResponse({
        limits: Mudrock.limits || {},
        enforced_for: {
          database_values: "max_heap_bytes",
          storage_upload_bodies: "max_request_body_bytes",
          invocation_responses: "max_response_body_bytes"
        }
      });
    }

    return jsonResponse({
      ok: true,
      routes: ["/notes", "/attachments", "/session", "/limits"]
    });
  }
};
