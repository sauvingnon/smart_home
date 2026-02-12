import { NextRequest } from 'next/server';

const BACKEND_URL = 'http://esp_service:8005';

// Правильная типизация для Next.js 15+
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;  // 👈 Ждём Promise
  const pathString = path.join('/');
  const url = `${BACKEND_URL}/${pathString}`;
  
  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (error) {
    return Response.json({ error: 'Failed to fetch' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;  // 👈 И здесь тоже
  const pathString = path.join('/');
  const url = `${BACKEND_URL}/${pathString}`;
  
  try {
    const body = await request.json();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (error) {
    return Response.json({ error: 'Failed to post' }, { status: 500 });
  }
}