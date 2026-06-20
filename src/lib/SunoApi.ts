import axios, { AxiosInstance } from 'axios';
import UserAgent from 'user-agents';
import pino from 'pino';
import { sleep } from '@/lib/utils';
import { accountTag, dumpHttpFailure } from '@/lib/diagnostics';
import * as cookie from 'cookie';
import { randomUUID } from 'node:crypto';
import { Solver } from '@2captcha/captcha-solver';

// sunoApi instance caching
const globalForSunoApi = global as unknown as { sunoApiCache?: Map<string, SunoApi> };
const cache = globalForSunoApi.sunoApiCache || new Map<string, SunoApi>();
globalForSunoApi.sunoApiCache = cache;

const logger = pino();
export const DEFAULT_MODEL = 'chirp-auk-turbo';

export interface AudioInfo {
  id: string; // Unique identifier for the audio
  title?: string; // Title of the audio
  image_url?: string; // URL of the image associated with the audio
  lyric?: string; // Lyrics of the audio
  audio_url?: string; // URL of the audio file
  video_url?: string; // URL of the video associated with the audio
  created_at: string; // Date and time when the audio was created
  model_name: string; // Name of the model used for audio generation
  gpt_description_prompt?: string; // Prompt for GPT description
  prompt?: string; // Prompt for audio generation
  status: string; // Status
  type?: string;
  tags?: string; // Genre of music.
  negative_tags?: string; // Negative tags of music.
  duration?: string; // Duration of the audio
  error_message?: string; // Error message if any
}

interface PersonaResponse {
  persona: {
    id: string;
    name: string;
    description: string;
    image_s3_id: string;
    root_clip_id: string;
    clip: any; // You can define a more specific type if needed
    user_display_name: string;
    user_handle: string;
    user_image_url: string;
    persona_clips: Array<{
      clip: any; // You can define a more specific type if needed
    }>;
    is_suno_persona: boolean;
    is_trashed: boolean;
    is_owned: boolean;
    is_public: boolean;
    is_public_approved: boolean;
    is_loved: boolean;
    upvote_count: number;
    clip_count: number;
  };
  total_results: number;
  current_page: number;
  is_following: boolean;
}

class SunoApi {
  private static BASE_URL: string = 'https://studio-api.prod.suno.com';
  private static CLERK_BASE_URL: string = 'https://auth.suno.com';
  private static CLERK_VERSION = '5.117.0';

  private readonly client: AxiosInstance;
  private sid?: string;
  private currentToken?: string;
  private deviceId?: string;
  private userAgent?: string;
  private cookies: Record<string, string | undefined>;
  private solver = new Solver(process.env.TWOCAPTCHA_KEY + '');

  constructor(cookies: string) {
    this.userAgent = new UserAgent(/Macintosh/).random().toString(); // Usually Mac systems get less amount of CAPTCHAs
    this.cookies = cookie.parse(cookies);
    this.deviceId = this.cookies.ajs_anonymous_id || randomUUID();
    this.client = axios.create({
      withCredentials: true,
      headers: {
        'Affiliate-Id': 'undefined',
        'device-id': this.deviceId,
        'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'referring-origin': 'https://suno.com',
        'referer': 'https://suno.com/',
        'User-Agent': this.userAgent
      }
    });
    this.client.interceptors.request.use(config => {
      if (this.currentToken && !config.headers.Authorization)
        config.headers.Authorization = `Bearer ${this.currentToken}`;
      const cookiesArray = Object.entries(this.cookies).map(([key, value]) => 
        cookie.serialize(key, value as string)
      );
      config.headers.Cookie = cookiesArray.join('; ');
      return config;
    });
    this.client.interceptors.response.use(resp => {
      const setCookieHeader = resp.headers['set-cookie'];
      if (Array.isArray(setCookieHeader)) {
        const newCookies = cookie.parse(setCookieHeader.join('; '));
        for (const [key, value] of Object.entries(newCookies)) {
          this.cookies[key] = value;
        }
      }
      return resp;
    })
  }

  public async init(): Promise<SunoApi> {
    //await this.getClerkLatestVersion();
    await this.getAuthToken();
    await this.keepAlive();
    return this;
  }

  /**
   * Get the clerk package latest version id.
   * This method is commented because we are now using a hard-coded Clerk version, hence this method is not needed.
   
  private async getClerkLatestVersion() {
    // URL to get clerk version ID
    const getClerkVersionUrl = `${SunoApi.JSDELIVR_BASE_URL}/v1/package/npm/@clerk/clerk-js`;
    // Get clerk version ID
    const versionListResponse = await this.client.get(getClerkVersionUrl);
    if (!versionListResponse?.data?.['tags']['latest']) {
      throw new Error(
        'Failed to get clerk version info, Please try again later'
      );
    }
    // Save clerk version ID for auth
    SunoApi.clerkVersion = versionListResponse?.data?.['tags']['latest'];
  }
  */

  /**
   * Get the session ID and save it for later use.
   */
  private async getAuthToken() {
    logger.info('Getting the session ID');
    // URL to get session ID
    const getSessionUrl = `${SunoApi.CLERK_BASE_URL}/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
    // Get session ID
    const sessionResponse = await this.client.get(getSessionUrl, {
      headers: { Authorization: this.cookies.__client }
    });
    if (!sessionResponse?.data?.response?.last_active_session_id) {
      throw new Error(
        'Failed to get session id, you may need to update the SUNO_COOKIE'
      );
    }
    // Save session ID for later use
    this.sid = sessionResponse.data.response.last_active_session_id;
  }

  /**
   * Keep the session alive.
   * @param isWait Indicates if the method should wait for the session to be fully renewed before returning.
   */
  public async keepAlive(isWait?: boolean): Promise<void> {
    if (!this.sid) {
      throw new Error('Session ID is not set. Cannot renew token.');
    }
    // URL to renew session token
    const renewUrl = `${SunoApi.CLERK_BASE_URL}/v1/client/sessions/${this.sid}/tokens?__clerk_api_version=2025-11-10&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
    // Renew session token
    logger.info('KeepAlive...\n');
    const renewResponse = await this.client.post(renewUrl, {}, {
      headers: { Authorization: this.cookies.__client }
    });
    if (isWait) {
      await sleep(1, 2);
    }
    const newToken = renewResponse.data.jwt;
    // Update Authorization field in request header with the new JWT token
    this.currentToken = newToken;
  }

  /**
   * Get the session token (not to be confused with session ID) and save it for later use.
   */
  private async getSessionToken() {
    const tokenResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/user/create_session_id/`,
      {
        session_properties: JSON.stringify({ deviceId: this.deviceId }),
        session_type: 1
      }
    );
    return tokenResponse.data.session_id;
  }

  private async captchaRequired(): Promise<boolean> {
    const resp = await this.client.post(`${SunoApi.BASE_URL}/api/c/check`, {
      ctype: 'generation'
    });
    logger.info(resp.data);
    return resp.data.required;
  }

  /**
   * Checks for CAPTCHA verification and solves the CAPTCHA if needed
   * @returns {string|null} hCaptcha token. If no verification is required, returns null
   */
  public async getCaptcha(): Promise<string|null> {
    // 调 Suno captcha check 接口确认是否需要验证 + 拿 sitekey/rqdata(若有)。
    // 关键:必须给 solver.hcaptcha 传 userAgent,且要与访问 Suno 的 UA 一致 —— 不传时 2captcha worker
    // 用不匹配的 UA 解题,实测 "unable to be solved after 3 attempts";传后稳定解出。
    // (rqdata 可选兜底:当前 Suno /api/c/check 只返回 {required,captcha_version},不下发 rqdata)
    const checkResp = await this.client.post(`${SunoApi.BASE_URL}/api/c/check`, { ctype: 'generation' });
    const check: any = checkResp.data || {};
    logger.info({ keys: Object.keys(check), check }, 'captcha /api/c/check');
    if (!check.required) return null;

    const rqdata: string | null = check.rqdata || null;
    const sitekey = check.sitekey || process.env.HCAPTCHA_SITEKEY || 'd65453de-3f1a-4aac-9366-a0f06e52b2ce';
    logger.info({ hasRqdata: !!rqdata, sitekey, ua: this.userAgent }, 'Solving hCaptcha via 2captcha');
    try {
      const res: any = await this.solver.hcaptcha({
        pageurl: 'https://suno.com/create',
        sitekey,
        userAgent: this.userAgent,
        ...(rqdata ? { data: rqdata } : {}),
      });
      const token = res?.data || res?.token;
      if (!token) throw new Error('2captcha returned empty hCaptcha token');
      logger.info({ tokenLen: token.length, hadRqdata: !!rqdata }, 'hCaptcha token received');
      return token;
    } catch (err: any) {
      await dumpHttpFailure(err, { account: accountTag(this.cookies.__client), step: 'hcaptcha_2captcha' }).catch(() => {});
      throw err;
    }
  }

  /**
   * Generate a song based on the prompt.
   * @param prompt The text prompt to generate audio from.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @returns
   */
  public async generate(
    prompt: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt,
      false,
      undefined,
      undefined,
      make_instrumental,
      model,
      wait_audio
    );
    const costTime = Date.now() - startTime;
    logger.info('Generate Response:\n' + JSON.stringify(audios, null, 2));
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Calls the concatenate endpoint for a clip to generate the whole song.
   * @param clip_id The ID of the audio clip to concatenate.
   * @returns A promise that resolves to an AudioInfo object representing the concatenated audio.
   * @throws Error if the response status is not 200.
   */
  public async concatenate(clip_id: string): Promise<AudioInfo> {
    await this.keepAlive(false);
    const payload: any = { clip_id: clip_id };

    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/concat/v2/`,
      payload,
      {
        timeout: 10000 // 10 seconds timeout
      }
    );
    if (response.status !== 200) {
      throw new Error('Error response:' + response.statusText);
    }
    return response.data;
  }

  /**
   * Generates custom audio based on provided parameters.
   *
   * @param prompt The text prompt to generate audio from.
   * @param tags Tags to categorize the generated audio.
   * @param title The title for the generated audio.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated audios.
   */
  public async custom_generate(
    prompt: string,
    tags: string,
    title: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt,
      true,
      tags,
      title,
      make_instrumental,
      model,
      wait_audio,
      negative_tags
    );
    const costTime = Date.now() - startTime;
    logger.info(
      'Custom Generate Response:\n' + JSON.stringify(audios, null, 2)
    );
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Generates songs based on the provided parameters.
   *
   * @param prompt The text prompt to generate songs from.
   * @param isCustom Indicates if the generation should consider custom parameters like tags and title.
   * @param tags Optional tags to categorize the song, used only if isCustom is true.
   * @param title Optional title for the song, used only if isCustom is true.
   * @param make_instrumental Indicates if the generated song should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @param task Optional indication of what to do. Enter 'extend' if extending an audio, otherwise specify null.
   * @param continue_clip_id 
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated songs.
   */
  private async generateSongs(
    prompt: string,
    isCustom: boolean,
    tags?: string,
    title?: string,
    make_instrumental?: boolean,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    task?: string,
    continue_clip_id?: string,
    continue_at?: number
  ): Promise<AudioInfo[]> {
    await this.keepAlive();
    // Suno 风控触发时要求 generate 带 hCaptcha token,否则返回 422 token_validation_failed。
    // 接入已有的 captchaRequired() + getCaptcha()(2captcha 解题),与网页端行为一致。
    let captchaToken: string | null = null;
    if (await this.captchaRequired()) {
      logger.info('Generation requires CAPTCHA. Solving via 2captcha...');
      captchaToken = await this.getCaptcha();
      if (!captchaToken) {
        throw new Error('CAPTCHA required but 2captcha returned no token');
      }
    }
    // 模拟 suno.com 网页端的 generate/v2-web 请求结构
    const payload: any = {
      token: captchaToken,
      generation_type: 'TEXT',
      title: isCustom ? (title || '') : '',
      tags: isCustom ? (tags || '') : '',
      negative_tags: isCustom ? (negative_tags || '') : '',
      mv: model || DEFAULT_MODEL,
      prompt: isCustom ? prompt : '',
      make_instrumental: make_instrumental,
      user_uploaded_images_b64: null,
      metadata: {
        web_client_pathname: '/create',
        is_max_mode: false,
        create_mode: isCustom ? 'custom' : 'description',
        user_tier: '4497580c-f4eb-4f86-9f0e-960eb7c48d7d', // 固定免费 tier;混合付费账号时需从 billing 响应动态读取 tier 替换此值
        create_session_token: randomUUID(),
        disable_volume_normalization: false
      },
      override_fields: [],
      cover_clip_id: null,
      cover_start_s: null,
      cover_end_s: null,
      persona_id: null,
      artist_clip_id: null,
      artist_start_s: null,
      artist_end_s: null,
      continue_clip_id: continue_clip_id,
      continued_aligned_prompt: null,
      continue_at: continue_at,
      task: task,
      transaction_uuid: randomUUID(),
      token_provider: captchaToken ? 1 : null
    };
    if (!isCustom) {
      payload.gpt_description_prompt = prompt;
    }
    logger.info(
      'generateSongs payload:\n' +
        JSON.stringify(
          {
            prompt: prompt,
            isCustom: isCustom,
            tags: tags,
            title: title,
            make_instrumental: make_instrumental,
            wait_audio: wait_audio,
            negative_tags: negative_tags,
            payload: payload
          },
          null,
          2
        )
    );
    let response;
    try {
      response = await this.client.post(
        `${SunoApi.BASE_URL}/api/generate/v2-web/`,
        payload,
        {
          timeout: 30000,
          headers: {
            // 网页端特有的 browser-token,内容仅为当前毫秒时间戳的 base64
            'browser-token': JSON.stringify({ token: Buffer.from(JSON.stringify({ timestamp: Date.now() })).toString('base64') }),
            'referring-pathname': '/'
          }
        }
      );
    } catch (err: any) {
      // axios 对非 2xx(含 422 token_validation_failed)/网络/超时统一 reject —— 落完整 response.data 再抛
      await dumpHttpFailure(err, { account: accountTag(this.cookies.__client), step: 'generate_v2_web' }).catch(() => {});
      throw err;
    }
    if (response.status !== 200) {
      const err: any = new Error('Error response:' + response.statusText);
      err.response = response;
      await dumpHttpFailure(err, { account: accountTag(this.cookies.__client), step: 'generate_v2_web' }).catch(() => {});
      throw err;
    }
    // 过滤试听版(preview):免费账号的 v5.5(fenix)为 60s 试听,无完整音频,只保留完整版(gen)
    const fullClips = response.data.clips.filter((audio: any) => audio.metadata?.type !== 'preview');
    const songIds = fullClips.map((audio: any) => audio.id);
    //Want to wait for music file generation
    if (wait_audio) {
      const startTime = Date.now();
      let lastResponse: AudioInfo[] = [];
      await sleep(5, 5);
      while (Date.now() - startTime < 100000) {
        const response = await this.get(songIds);
        const allCompleted = response.every(
          (audio) => audio.status === 'streaming' || audio.status === 'complete'
        );
        const allError = response.every((audio) => audio.status === 'error');
        if (allCompleted || allError) {
          return response;
        }
        lastResponse = response;
        await sleep(3, 6);
        await this.keepAlive(true);
      }
      return lastResponse;
    } else {
      return fullClips.map((audio: any) => ({
        id: audio.id,
        title: audio.title,
        image_url: audio.image_url,
        lyric: audio.metadata.prompt,
        audio_url: audio.audio_url,
        video_url: audio.video_url,
        created_at: audio.created_at,
        model_name: audio.model_name,
        status: audio.status,
        gpt_description_prompt: audio.metadata.gpt_description_prompt,
        prompt: audio.metadata.prompt,
        type: audio.metadata.type,
        tags: audio.metadata.tags,
        negative_tags: audio.metadata.negative_tags,
        duration: audio.metadata.duration
      }));
    }
  }

  /**
   * Generates lyrics based on a given prompt.
   * @param prompt The prompt for generating lyrics.
   * @returns The generated lyrics text.
   */
  public async generateLyrics(prompt: string): Promise<string> {
    await this.keepAlive(false);
    // Initiate lyrics generation
    const generateResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/lyrics/`,
      { prompt }
    );
    const generateId = generateResponse.data.id;

    // Poll for lyrics completion
    let lyricsResponse = await this.client.get(
      `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
    );
    while (lyricsResponse?.data?.status !== 'complete') {
      await sleep(2); // Wait for 2 seconds before polling again
      lyricsResponse = await this.client.get(
        `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
      );
    }

    // Return the generated lyrics text
    return lyricsResponse.data;
  }

  /**
   * Extends an existing audio clip by generating additional content based on the provided prompt.
   *
   * @param audioId The ID of the audio clip to extend.
   * @param prompt The prompt for generating additional content.
   * @param continueAt Extend a new clip from a song at mm:ss(e.g. 00:30). Default extends from the end of the song.
   * @param tags Style of Music.
   * @param title Title of the song.
   * @returns A promise that resolves to an AudioInfo object representing the extended audio clip.
   */
  public async extendAudio(
    audioId: string,
    prompt: string = '',
    continueAt: number,
    tags: string = '',
    negative_tags: string = '',
    title: string = '',
    model?: string,
    wait_audio?: boolean
  ): Promise<AudioInfo[]> {
    return this.generateSongs(prompt, true, tags, title, false, model, wait_audio, negative_tags, 'extend', audioId, continueAt);
  }

  /**
   * Generate stems for a song.
   * @param song_id The ID of the song to generate stems for.
   * @returns A promise that resolves to an AudioInfo object representing the generated stems.
   */
  public async generateStems(song_id: string): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/edit/stems/${song_id}`, {}
    );

    console.log('generateStems response:\n', response?.data);
    return response.data.clips.map((clip: any) => ({
      id: clip.id,
      status: clip.status,
      created_at: clip.created_at,
      title: clip.title,
      stem_from_id: clip.metadata.stem_from_id,
      duration: clip.metadata.duration
    }));
  }


  /**
   * Get the lyric alignment for a song.
   * @param song_id The ID of the song to get the lyric alignment for.
   * @returns A promise that resolves to an object containing the lyric alignment.
   */
  public async getLyricAlignment(song_id: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApi.BASE_URL}/api/gen/${song_id}/aligned_lyrics/v2/`);

    console.log(`getLyricAlignment ~ response:`, response.data);
    return response.data?.aligned_words.map((transcribedWord: any) => ({
      word: transcribedWord.word,
      start_s: transcribedWord.start_s,
      end_s: transcribedWord.end_s,
      success: transcribedWord.success,
      p_align: transcribedWord.p_align
    }));
  }

  /**
   * Processes the lyrics (prompt) from the audio metadata into a more readable format.
   * @param prompt The original lyrics text.
   * @returns The processed lyrics text.
   */
  private parseLyrics(prompt: string): string {
    // Assuming the original lyrics are separated by a specific delimiter (e.g., newline), we can convert it into a more readable format.
    // The implementation here can be adjusted according to the actual lyrics format.
    // For example, if the lyrics exist as continuous text, it might be necessary to split them based on specific markers (such as periods, commas, etc.).
    // The following implementation assumes that the lyrics are already separated by newlines.

    // Split the lyrics using newline and ensure to remove empty lines.
    const lines = prompt.split('\n').filter((line) => line.trim() !== '');

    // Reassemble the processed lyrics lines into a single string, separated by newlines between each line.
    // Additional formatting logic can be added here, such as adding specific markers or handling special lines.
    return lines.join('\n');
  }

  /**
   * Retrieves audio information for the given song IDs.
   * @param songIds An optional array of song IDs to retrieve information for.
   * @param page An optional page number to retrieve audio information from.
   * @returns A promise that resolves to an array of AudioInfo objects.
   */
  public async get(
    songIds?: string[],
    page?: string | null
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    let url = new URL(`${SunoApi.BASE_URL}/api/feed/v2`);
    if (songIds) {
      url.searchParams.append('ids', songIds.join(','));
    }
    if (page) {
      url.searchParams.append('page', page);
    }
    logger.info('Get audio status: ' + url.href);
    const response = await this.client.get(url.href, {
      // 10 seconds timeout
      timeout: 10000
    });

    const audios = response.data.clips;

    return audios.map((audio: any) => ({
      id: audio.id,
      title: audio.title,
      image_url: audio.image_url,
      lyric: audio.metadata.prompt
        ? this.parseLyrics(audio.metadata.prompt)
        : '',
      audio_url: audio.audio_url,
      video_url: audio.video_url,
      created_at: audio.created_at,
      model_name: audio.model_name,
      status: audio.status,
      gpt_description_prompt: audio.metadata.gpt_description_prompt,
      prompt: audio.metadata.prompt,
      type: audio.metadata.type,
      tags: audio.metadata.tags,
      duration: audio.metadata.duration,
      error_message: audio.metadata.error_message
    }));
  }

  /**
   * Retrieves information for a specific audio clip.
   * @param clipId The ID of the audio clip to retrieve information for.
   * @returns A promise that resolves to an object containing the audio clip information.
   */
  public async getClip(clipId: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/clip/${clipId}`
    );
    return response.data;
  }

  public async get_credits(): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/billing/info/`
    );
    return {
      credits_left: response.data.total_credits_left,
      period: response.data.period,
      monthly_limit: response.data.monthly_limit,
      monthly_usage: response.data.monthly_usage
    };
  }

  public async getPersonaPaginated(personaId: string, page: number = 1): Promise<PersonaResponse> {
    await this.keepAlive(false);
    
    const url = `${SunoApi.BASE_URL}/api/persona/get-persona-paginated/${personaId}/?page=${page}`;
    
    logger.info(`Fetching persona data: ${url}`);
    
    const response = await this.client.get(url, {
      timeout: 10000 // 10 seconds timeout
    });

    if (response.status !== 200) {
      throw new Error('Error response: ' + response.statusText);
    }

    return response.data;
  }
}

export const sunoApi = async (cookie?: string) => {
  const resolvedCookie = cookie && cookie.includes('__client') ? cookie : process.env.SUNO_COOKIE; // Check for bad `Cookie` header (It's too expensive to actually parse the cookies *here*)
  if (!resolvedCookie) {
    logger.info('No cookie provided! Aborting...\nPlease provide a cookie either in the .env file or in the Cookie header of your request.')
    throw new Error('Please provide a cookie either in the .env file or in the Cookie header of your request.');
  }

  // Check if the instance for this cookie already exists in the cache
  const cachedInstance = cache.get(resolvedCookie);
  if (cachedInstance)
    return cachedInstance;

  // If not, create a new instance and initialize it
  const instance = await new SunoApi(resolvedCookie).init();
  // Cache the initialized instance
  cache.set(resolvedCookie, instance);

  return instance;
};

// ===================== 多账号轮询 + 余额感知 =====================

/** 所有账号都不可用(无积分或全部失败)时抛出,路由层映射为 503 */
export class AllAccountsExhausted extends Error {
  constructor(message: string, public override cause?: unknown) {
    super(message);
    this.name = 'AllAccountsExhausted';
  }
}

/** 解析多 cookie:`SUNO_COOKIES`(||| 分隔)优先,否则 fallback `SUNO_COOKIE`(单个) */
function parseCookiesEnv(): string[] {
  const multi = process.env.SUNO_COOKIES;
  if (multi && multi.trim()) {
    return multi
      .split('|||')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.includes('__client'));
  }
  const single = process.env.SUNO_COOKIE;
  return single && single.includes('__client') ? [single] : [];
}

/** 账号池:round-robin 轮询 + 余额感知(复用上面的 sunoApi(cookie) 实例缓存) */
class SunoApiPool {
  private cookies: string[] = parseCookiesEnv();
  private cursor = 0;
  private ttlMs = 60_000; // 余额缓存 60s
  private creditsCache = new Map<string, { left: number; expiresAt: number }>();
  private inflight = new Map<string, Promise<number>>(); // 并发查余额去重

  /** 选一个有积分的账号,返回已 init 的 SunoApi 实例 + 其 cookie */
  async acquire(): Promise<{ api: SunoApi; cookie: string }> {
    if (this.cookies.length === 0) {
      throw new AllAccountsExhausted(
        'No accounts configured. Set SUNO_COOKIES or SUNO_COOKIE in .env.'
      );
    }
    const n = this.cookies.length;
    let lastErr: unknown;
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n;
      const cookie = this.cookies[idx];
      try {
        const left = await this.getCredits(cookie);
        if (left > 0) {
          this.cursor = (idx + 1) % n; // 推进游标,实现轮流
          logger.info({ account: idx, credits_left: left }, 'pool: acquire account');
          return { api: await sunoApi(cookie), cookie };
        }
        logger.info({ account: idx, credits_left: left }, 'pool: skip (no credits)');
      } catch (e) {
        lastErr = e;
        this.creditsCache.delete(cookie);
        logger.warn({ account: idx, err: (e as Error).message }, 'pool: credit check failed, skip');
      }
    }
    throw new AllAccountsExhausted('All accounts exhausted (no credits or all failed).', lastErr);
  }

  /** 查某账号余额,TTL 缓存 + 并发去重 */
  private async getCredits(cookie: string): Promise<number> {
    const cached = this.creditsCache.get(cookie);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.left;
    }
    let p = this.inflight.get(cookie);
    if (!p) {
      p = (async () => {
        try {
          const api = await sunoApi(cookie);
          const info = (await api.get_credits()) as { credits_left: number };
          this.creditsCache.set(cookie, {
            left: info.credits_left,
            expiresAt: Date.now() + this.ttlMs,
          });
          return info.credits_left;
        } finally {
          this.inflight.delete(cookie);
        }
      })();
      this.inflight.set(cookie, p);
    }
    return p;
  }

  /** 生成成功后扣减缓存(默认每次生成约 10 credits / 2 首) */
  noteConsumption(cookie: string, cost: number = 10): void {
    const cached = this.creditsCache.get(cookie);
    if (cached) {
      cached.left = Math.max(0, cached.left - cost);
    }
  }

  /** 生成时实际 402 等情况,强制刷新某账号余额 */
  invalidate(cookie: string): void {
    this.creditsCache.delete(cookie);
  }
}

// 全局单例(跨 hot-reload 复用)
const globalForPool = global as unknown as { __sunoPool?: SunoApiPool };
export const pool: SunoApiPool = globalForPool.__sunoPool ?? (globalForPool.__sunoPool = new SunoApiPool());

/** 路由统一入口:请求带有效 Cookie → 用请求的(覆盖);否则走池 */
export async function sunoApiFromRequest(cookieHeader?: string): Promise<{ api: SunoApi; cookie: string; pooled: boolean }> {
  if (cookieHeader && cookieHeader.includes('__client')) {
    return { api: await sunoApi(cookieHeader), cookie: cookieHeader, pooled: false };
  }
  const { api, cookie } = await pool.acquire();
  return { api, cookie, pooled: true };
}

/** 直接走池(无请求 cookie 的入口,如 /v1/chat/completions) */
export async function sunoApiPooled(): Promise<{ api: SunoApi; cookie: string; pooled: boolean }> {
  const { api, cookie } = await pool.acquire();
  return { api, cookie, pooled: true };
}