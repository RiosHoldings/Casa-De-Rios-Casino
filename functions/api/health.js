export function onRequest() {
  return Response.json({
    ok: true,
    service: "Casa de Ríos Casino API",
    status: "online",
    message: "Cloudflare Pages Functions are working."
  });
}
