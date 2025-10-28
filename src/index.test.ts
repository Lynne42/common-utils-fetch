import { beforeAll, describe, expect, test } from 'vitest';
import request from './index.js';

const baseurl = 'https://jsonplaceholder.typicode.com';

beforeAll(() => {
    request.interceptors.request.use(({ url, options }) => {
        console.log('请求拦截器被调用, 添加baseurl');
        return {
            url: baseurl + url,
            options: options
        };
    });

})

describe('fetch封装库测试', () => {
    test('测试多个请求拦截器', async () => {

        request.interceptors.request.use(({ url, options }) => {
            console.log('请求拦截器被调用');
            return {
                options: {
                    ...options,
                    headers: {
                        ...options.headers,
                        'X-Test-Header-2': 'interceptors.request.2'
                    }
                }
            };
        });

        const res = await request('/posts/1', {
            method: 'GET',
        });
        expect(res.ok).toBe(true);
        expect(res.status).toBe(200);
        expect(request.interceptors.request.size()).toBe(2);
        const data = await res.json();
        expect(data).toEqual({
            userId: expect.any(Number),
            id: expect.any(Number),
            title: expect.any(String),
            body: expect.any(String),
        })
    });
    test('测试多个响应拦截器', async () => {

        const id1 = request.interceptors.response.use(async response => {
            if (response.ok) {
                return await response.json()
            }
            return response
        })
        const id2 = request.interceptors.response.use(async response => {
            console.log('注册2响应拦截器')
            return response
        })
        const res = await request('/posts/1', {
            method: 'GET',
        });

        expect(res).toEqual({
            userId: expect.any(Number),
            id: expect.any(Number),
            title: expect.any(String),
            body: expect.any(String),
        })

        request.interceptors.response.eject(id1)
        request.interceptors.response.eject(id2)


    })
    test('测试get-普通请求-成功', async () => {
        const res = await request('/posts/1', {
            method: 'GET',
        });
        const data = await res.json();
        expect(data).toEqual({
            userId: expect.any(Number),
            id: expect.any(Number),
            title: expect.any(String),
            body: expect.any(String),
        })
    });
    test('测试get-普通请求-失败', async () => {

        const res = await request('/posts/2w22', {
            method: 'GET',
        });
        const data = await res.json();
        expect(data).not.toEqual({
            userId: expect.any(Number),
            id: expect.any(Number),
            title: expect.any(String),
            body: expect.any(String),
        })

    });
    test('测试超时', async () => {
        try {
            request.timeout = 2;
            const res = await request('/posts/2', {
                method: 'GET',
            });
        } catch (error: any) {
            console.log('error', error.name)
            expect(error.name).toBe('TimeoutError')
        } finally {
            request.timeout = 5000;
        }
    })
    test('测试请求json数据格式化', async () => {
        const res = await request('/posts', {
            method: 'POST',
            data: {
                title: 'foo',
                body: 'bar',
                userId: 1,
            }
        });
        expect(res.ok).toBe(true)
        const data = await res.json()
        expect(data).toHaveProperty('id')
    })
    test('测试取消请求', async () => {
        const control = new AbortController();
        setTimeout(() => {
            control.abort()
        }, 0)
        try {
            await request('/posts', {
                method: 'POST',
                data: {
                    title: 'foo444',
                    body: 'bar444',
                    userId: 1,
                },
                signal: control.signal,
            });
        } catch (error: any) {
            console.log('取消请求', error)
            expect(error.name).toBe('AbortError')
        }
    })
    
});