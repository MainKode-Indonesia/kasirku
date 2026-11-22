export async function request(path, options = {}) {
  const { headers, ...requestOptions } = options;
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...headers },
    ...requestOptions,
  });
  const body = await response.text();
  let data;
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    const error = new Error(response.ok ? "Respons server tidak valid." : `Server mengembalikan kesalahan (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const message = data.error || (response.status >= 500
      ? "Server API tidak tersedia. Jalankan npm run api dan pastikan MongoDB aktif."
      : "Permintaan gagal.");
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}
