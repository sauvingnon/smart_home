import { NextRequest } from 'next/server';

// Адрес бекенда в Docker сети
const BACKEND_URL = 'http://esp_service:8005';

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const path = params.path.join('/');
  const url = `${BACKEND_URL}/${path}`;
  
  try {
    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (error) {
    console.error('Proxy error:', error);
    return Response.json(
      { error: 'Failed to fetch from backend' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const path = params.path.join('/');
  const url = `${BACKEND_URL}/${path}`;
  
  try {
    const body = await request.json();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    
    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (error) {
    console.error('Proxy error:', error);
    return Response.json(
      { error: 'Failed to post to backend' },
      { status: 500 }
    );
  }
}