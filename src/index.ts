/**
 * 封装fetch请求, 实现常用的几个功能
 * [✅] 1. 支持超时设置
 * [✅] 2. 支持请求和响应拦截器
 * [✅] 3. 错误统一处理
 * [✅] 4. JSON自动序列化
 * [✅] 5. 取消请求
 * [✅] 6. 重试策略
 * [✅] 7. 上传下载进度回调
 * 8. 可选：缓存和去重(暂时不做去重)机制
 * 9. 可选：请求队列管理： 可在业务侧单独封装，职责单一且隔离
 * 10. 可选：并发请求限制： 可在业务侧单独封装，职责单一且隔离
*/

import InterceptorManager from './interceptorManager.js';

export type RequestOptions = {
    requestType?: 'json' | 'form' | 'text' | 'blob' | 'arrayBuffer';  // 请求体类型
    responseType?: 'json' | 'text' | 'blob' | 'arrayBuffer'; // 响应体类型
    // dedupe?: boolean;                      // 是否启用请求去重
    cache?: boolean;                      // 是否启用请求缓存
    timeout?: number;                         // 超时时间，单位毫秒
    retries?: number;                         // 重试次数
    retryDelay?: number;                      // 重试间隔，单位毫秒
    onUploadProgress?: (params: { progress: number, [x: string]: any }) => void;    // 上传进度回调
    onDownloadProgress?: (params: { progress: number, [x: string]: any }) => void;  // 下载进度回调
    signal?: AbortSignal | null;                     // 取消请求的信号
    params?: Record<string, any>;               // get 请求 URL参数
    data?: any;                                 // 请求体参数
    body?: any;
    bodyCopy?: any;                            // 用于重试的body副本
} & Omit<RequestInit, 'body'>;

export interface RequestContext {
    url: string;
    options: RequestOptions;
}
export type ReqInterceptor = (
    ctx: RequestContext
) => Promise<Partial<RequestContext> | void> | Partial<RequestContext> | void;

export type ResInterceptor = (response: Response) => Promise<Response> | Response;

export enum ResponseErrorType {
    'TimeoutError' = 'TimeoutError',
    'AbortError' = 'AbortError',
}

// 规范化Headers
function normalizeHeaders(init?: HeadersInit): Headers {
    return init instanceof Headers ? init : new Headers(init);
}

// 默认的content-type头
const defaultsHeaders = {
    'Content-Type': 'application/json;charset=utf-8',
}

// 根据body内容检测合适的content-type
function detectContentType(body: any): string | undefined {
    if (typeof body === 'string') return 'text/plain;charset=UTF-8';
    if (body instanceof FormData) return undefined;
    if (body instanceof URLSearchParams) return 'application/x-www-form-urlencoded;charset=UTF-8';
    if (body instanceof Blob) return body.type || 'application/octet-stream';
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return 'application/octet-stream';
    if (typeof body === 'object') return 'application/json';
    return undefined;
}

// 判断 body 是否可重用(在重试的过程中，有些 body 类型是不可重用的，比如 ReadableStream)
function isBodyReusable(body: any): boolean {
    // 字符串、JSON-able 对象、URLSearchParams、FormData、Blob、ArrayBuffer/TypedArray 都可以复用
    // 但 ReadableStream、Request（含流）通常不可复用
    if (!body) return true;
    if (typeof body === 'string') return true;
    if (body instanceof URLSearchParams) return true;
    if (body instanceof FormData) return true;
    if (body instanceof Blob) return true;
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
    // 对象：我们会 stringify 后复用
    if (typeof body === 'object') return true;
    // 否则视为不可重用
    return false;
}

// 将xhr xhr.getAllResponseHeaders()字符串解析成对象或数组
function parseXHRHeaders(headerStr: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (!headerStr) return headers;

    headerStr.split(/\r?\n/).forEach(line => {
        const [key, ...rest] = line.split(':');
        if (!key) return;
        headers[key.trim()] = rest.join(':').trim();
    });

    return headers;
}

class CommonRequest {
    // 默认参数
    defaults: RequestOptions;

    // 超时处理
    private _timeout: number;

    // // 去重管理
    // dedupeMap: Map<string, Promise<Response>> = new Map();

    // 缓存管理
    // cacheMap: Map<string, Response> = new Map();

    // 拦截器管理
    interceptors: {
        request: InterceptorManager<ReqInterceptor>,
        response: InterceptorManager<ResInterceptor>,
    }

    constructor(defaultParams: Partial<RequestOptions> = {}) {
        this.defaults = {
            requestType: 'json',
            responseType: 'json',
            // dedupe: true,
            // cache: false,
            timeout: 5000, // 默认超时5秒
            retries: 0,   // 默认重试0次
            retryDelay: 2000, // 默认重试间隔2秒
            signal: null,
            ...defaultParams,
        }
        this._timeout = 5000;
        this.interceptors = {
            request: new InterceptorManager<ReqInterceptor>(),
            response: new InterceptorManager<ResInterceptor>(),
        }
    }

    // 延时函数
    private delay(ms: number) {
        return new Promise<void>(r => setTimeout(r, ms));
    }

    // 请求体标准化
    private normalizeRequestOptions(options: RequestOptions): any {
        const headers = normalizeHeaders(options.headers || {});
        const body = options.data;

        const contentTypeExisting = headers.get('Content-Type') || headers.get('content-type') || '';
        const contentTypeLower = contentTypeExisting.toLowerCase();

        // 处理content-type: 如果没有 set content-type 且我们能探测出类型，则设置它（FormData 不应该设置）
        const autoCt = detectContentType(body);
        if (!contentTypeExisting && autoCt) {
            headers.set('Content-Type', autoCt);
        }
        options.headers = headers;

        // 处理JSON-body: 如果是 JSON 类型并且 body 是可序列化对象，则 stringify（排除 FormData/Blob/ArrayBuffer）
        options.body = body;
        const shouldStringify = contentTypeLower.includes('application/json') &&
            body !== undefined &&
            typeof body === 'object' &&
            !(body instanceof FormData) &&
            !(body instanceof Blob) &&
            !(body instanceof ArrayBuffer) &&
            !(body instanceof URLSearchParams);

        if (shouldStringify) {
            options.body = JSON.stringify(body);
        }

        // 处理 bodyCopy: 用于重试
        if (options.body && !isBodyReusable(options.body)) {
            options.bodyCopy = structuredClone(options.body);
        }

        // 处理 signal： 方便后续处理取消请求
        options.signal = options.signal || new AbortController().signal;

        // 处理get请求下的 URL参数
        if (options.method?.toUpperCase() === 'GET' && options.params) {
            const url = new URL(options.url || '', window.location.origin);
            Object.entries(options.params).forEach(([key, value]) => {
                url.searchParams.append(key, String(value));
            });
            options.url = url.toString();
        }

        return options;
    }

    // 请求url标准化， 处理get请求下的 URL参数
    private normalizeRequestOptionsUrl(url: string, options: RequestOptions): string {
        // 处理get请求下的 URL参数
        let key = url;
        if (options.method?.toUpperCase() === 'GET' && options.params) {
            const searchParams = [...(new URLSearchParams(options.params)).entries()].sort(([keyA, valA], [keyB, valB]) => {
                if (keyA < keyB) return -1;
                if (keyA > keyB) return 1;
                if (valA < valB) return -1;
                if (valA > valB) return 1;
                return 0;
            })
            key += '?' + new URLSearchParams(searchParams).toString();
        }
        return key;
    }

    // 超时处理
    private async timeoutPromise(resource: string, options: RequestOptions, timeout: number, userSignal: AbortSignal | null): Promise<Response> {
        const controller = new AbortController();
        if (userSignal) {
            if (userSignal.aborted) controller.abort();
            else userSignal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        const timer = !!timeout ? setTimeout(() => {
            controller.abort();
        }, timeout) : null;

        try {
            const res = await fetch(resource, {
                ...options,
                signal: controller.signal,
            });
            if (timer) clearTimeout(timer);
            return res;
        } catch (err: any) {
            if (timer) clearTimeout(timer);
            if (err && err?.name === 'AbortError') {
                if (userSignal && userSignal.aborted) {
                    // 用户主动取消
                    const userErr = new Error('Request aborted by user');
                    (userErr as any).name = 'AbortError';
                    throw userErr;
                } else {
                    // 超时导致的 abort（或内部其他 abort）
                    const tErr = new Error('Request timed out');
                    (tErr as any).name = 'TimeoutError';
                    throw tErr;
                }
            }
            throw err;
        }
    }

    // 应用请求拦截器
    async applyRequestInterceptors(ctx: RequestContext): Promise<RequestContext> {
        if (this.interceptors.request.size() <= 0) {
            return ctx;
        }
        let newCtx = ctx;
        // 逐个应用拦截器
        await this.interceptors.request.forEachAsync(async (interceptor) => {
            const result = await interceptor(ctx);
            if (result) {
                newCtx = {
                    url: result.url ?? newCtx.url,
                    options: result.options ?? newCtx.options,
                };
            }
        });
        return newCtx;
    }

    // 应用响应拦截器
    async applyResponseInterceptors(response: Response): Promise<Response> {

        if (this.interceptors.response.size() <= 0) {
            return response;
        }
        let res = response;
        await this.interceptors.response.forEachReverseAsync(async (interceptor) => {
            res = await interceptor(res);
        });
        return res;
    }

    // 下载进度回调
    async downloadWithProgress(url: string, options: RequestOptions, onDownloadProgress: NonNullable<RequestOptions['onDownloadProgress']>): Promise<Response> {
        const controller = new AbortController();
        const userSignal = options.signal;
        if (userSignal) {
            if (userSignal.aborted) controller.abort();
            else userSignal.addEventListener('abort', () => controller.abort(), { once: true });
        }
        try {

            const res = await fetch(url, { ...options, signal: controller.signal });
            if (!res.body || !res.ok) {
                throw new Error(`HTTP error ${res.status}`);
            }
            const [progressStream, stream2] = res.body.tee();
            const contentLength = res.headers.get('Content-Length');
            const total = contentLength ? parseInt(contentLength, 10) : NaN;
            const reader = progressStream.getReader();
            let receivedLength = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                    receivedLength += value.length;
                    onDownloadProgress({
                        finished: receivedLength,
                        total,
                        progress: total ? receivedLength / total : -1,
                    });
                }
            }

            return new Response(stream2);

        } catch (error: any) {
            if (error && error?.name === 'AbortError') {
                if (userSignal && userSignal.aborted) {
                    // 用户主动取消
                    const userErr = new Error('Request aborted by user');
                    (userErr as any).name = 'AbortError';
                    throw userErr;
                } else {
                    // 超时导致的 abort（或内部其他 abort）
                    const tErr = new Error('Request timed out');
                    (tErr as any).name = 'TimeoutError';
                    throw tErr;
                }
            }
            throw error;
        }

    }

    // 上传进度回调
    uploadWithProgress(url: string, options: RequestOptions, onUploadProgress: NonNullable<RequestOptions['onUploadProgress']>): Promise<Response> {
        // 注意：Fetch API 原生并不支持上传进度回调，这里只是一个占位符
        // 实际应用中可能需要使用 xhrHttpRequest 来实现上传进度回调功能
        const that = this;
        return new Promise<Response>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.timeout = options.timeout || that.timeout;

            xhr.responseType = 'text';


            // 创建一个post请求，使用异步的方式
            xhr.open(options.method || 'POST', url, true);

            // 设置请求头
            const headers = options.headers as Headers;
            headers.forEach((value, key) => {
                if (key !== 'body') {
                    xhr.setRequestHeader(key, value);
                }
            });

            // 注册事件回调
            xhr.onreadystatechange = function () {
                if (xhr.readyState === 4 && xhr.status === 200) {
                    const data = JSON.parse(xhr.responseText);
                    if (data.status === 200) {
                        resolve(new Response(xhr.responseText, {
                            status: 200,
                            statusText: 'OK',
                            headers: parseXHRHeaders(xhr.getAllResponseHeaders()),
                        }));
                    } else {
                        resolve(new Response(data, {
                            status: xhr.status,
                            statusText: xhr.statusText,
                            headers: parseXHRHeaders(xhr.getAllResponseHeaders()),
                        }));
                    }
                }
            }

            // 注册上传进度回调
            xhr.upload.onprogress = function (event) {
                if (event.lengthComputable) {
                    const progress = Math.round((event.loaded / event.total) * 100);

                    onUploadProgress({
                        finished: event.loaded,
                        total: event.total,
                        progress,
                    });
                }
            };

            // 注册超时回调
            xhr.ontimeout = function (event) {
                const error = new TypeError('Request timed out'); // 类似 fetch 的错误类型
                // 可以把 xhr 对象附加上去，方便调试
                (error as any).xhr = xhr;
                (error as any).name = 'TimeoutError';
                reject(error);
            }

            // 注册取消回调
            xhr.onabort = function (event) {
                const error = new TypeError('Request aborted by user'); // 类似 fetch 的错误类型
                // 可以把 xhr 对象附加上去，方便调试
                (error as any).xhr = xhr;
                (error as any).name = 'AbortError';
                reject(error);
            }

            // 注册错误回调
            xhr.onerror = function (event) {
                const error = new TypeError('Network Error'); // 类似 fetch 的错误类型
                // 可以把 xhr 对象附加上去，方便调试
                (error as any).xhr = xhr;
                (error as any).name = 'NetworkError';
                reject(error);
            };

            // 发送请求
            try {
                xhr.send(options.body);
            } catch (error) {
                const err = new TypeError('Network Error');
                (err as any).xhr = xhr;
                (error as any).name = 'NetworkError';
                reject(err);
            }

            const userSignal = options.signal;
            if (userSignal) {
                if (userSignal.aborted) xhr.abort();
                else userSignal.addEventListener('abort', () => xhr.abort(), { once: true });
            }
        });
    }

    // 核心请求函数
    async request(urlStr: string, opts: RequestOptions): Promise<any> {
        const that = this;

        let url = that.normalizeRequestOptionsUrl(urlStr, opts as RequestOptions);
        let options: RequestOptions = that.normalizeRequestOptions({ ...this.defaults, ...(opts || {}) });
        // 使用请求拦截器
        const ctx = await that.applyRequestInterceptors({ url, options })
        url = ctx.url;
        options = ctx.options;

        // 如果是下载进度回调，使用专门的处理函数downloadWithProgress去处理下载功能
        if (options.onDownloadProgress) {
            return this.downloadWithProgress(url, options, options.onDownloadProgress);
        }
        // 如果是上传进度回调，使用专门的处理函数uploadWithProgress去处理上传功能
        if (options.onUploadProgress) {
            return this.uploadWithProgress(url, options, options.onUploadProgress);
        }
        // 普通fetch请求 + 重试机制

        // 已经重试次数
        let attempts = 0;

        // 保存错误
        let lastError: any = null;

        // 预期重试次数
        const retries = options.retries ?? 0;

        // 重试时间间隔
        // const retryDelay = options.retryDelay ?? ((attempt: number) => 100 * Math.pow(2, attempt));
        const retryDelay = options.retryDelay ?? 2000;

        // 真实请求执行函数
        while (attempts <= retries) {
            if (options.bodyCopy) {
                options.body = options.bodyCopy;
            }
            try {

                const res = await this.timeoutPromise(
                    url,
                    {
                        ...options,
                    },
                    options.timeout || that.timeout,
                    options.signal!,
                )

                // 应用响应拦截器
                const finalRes = await that.applyResponseInterceptors(res);

                return finalRes;

            } catch (error: Error | any) {
                lastError = error;

                // 如果是 abort（AbortError），立即抛出，不重试
                if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
                    // 用户取消或超时 — 不再重试
                    throw error;
                }

                // 若达到最大重试次数，抛出最后一次错误
                if (attempts >= retries) {
                    throw lastError;
                }

                // 否则等待一段时间后重试
                await that.delay(retryDelay);
                attempts += 1;
                continue;
            }
        }

        throw lastError;
    }

    get timeout() {
        return this._timeout;
    }
    set timeout(value) {
        this._timeout = value;
        this.defaults = {
            ...this.defaults,
            timeout: value
        }
    }
}

function createRequest(instance: CommonRequest) {
  const fn = function (url: string, options: RequestOptions) {
    return instance.request(url, options);
  } as typeof instance.request & CommonRequest;

  Object.defineProperty(fn, 'timeout', {
    get: () => instance.timeout,
    set: v => instance.timeout = v
  });

  Object.defineProperty(fn, 'interceptors', {
    get: () => instance.interceptors
  });
  return fn
}

const commonRequest: CommonRequest = new CommonRequest();
const request = createRequest(commonRequest);


export default request;
