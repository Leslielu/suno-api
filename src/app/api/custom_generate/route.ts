import { NextResponse, NextRequest } from "next/server";
import { cookies } from 'next/headers';
import { DEFAULT_MODEL, sunoApi, sunoApiFromRequest, pool, AllAccountsExhausted } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";
import { withRequestLog } from "@/lib/requestLog";

export const maxDuration = 60; // allow longer timeout for wait_audio == true
export const dynamic = "force-dynamic";

async function handle(req: NextRequest) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const { prompt, tags, title, make_instrumental, model, wait_audio, negative_tags } = body;
      const { api, cookie, pooled } = await sunoApiFromRequest((await cookies()).toString());
      const audioInfo = await api.custom_generate(
        prompt, tags, title,
        Boolean(make_instrumental),
        model || DEFAULT_MODEL,
        Boolean(wait_audio),
        negative_tags
      );
      if (pooled) pool.noteConsumption(cookie);
      return new NextResponse(JSON.stringify(audioInfo), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error: any) {
      console.error('Error generating custom audio:', error);
      if (error instanceof AllAccountsExhausted) {
        return new NextResponse(JSON.stringify({ error: 'All accounts have no credits left' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      return new NextResponse(JSON.stringify({ error: error.response?.data?.detail || error.toString() }), {
        status: error.response?.status || 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  } else {
    return new NextResponse('Method Not Allowed', {
      headers: {
        Allow: 'POST',
        ...corsHeaders
      },
      status: 405
    });
  }
}

export const POST = withRequestLog('custom_generate', handle);

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}
