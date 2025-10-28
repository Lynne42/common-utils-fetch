class InterceptorManager<T> {
    private interceptors: Map<number, T> = new Map();
    private interceptorIds: number[] = [];
    private nextId: number = 0;

    // 注册拦截器，返回拦截器 ID
    use(interceptor: T): number {
        const id = this.nextId++;
        this.interceptorIds.push(id);
        this.interceptors.set(id, interceptor);
        return id;
    }

    // 注销拦截器
    eject(id: number): void {
        this.interceptorIds = this.interceptorIds.filter(i => i !== id);
        this.interceptors.delete(id);
    }

    // 顺序遍历所有拦截器
    async forEachAsync(fn: (interceptor: T) => Promise<void> | void): Promise<void> {
        for (const id of this.interceptorIds) {
            const interceptor = this.interceptors.get(id);
            if (!interceptor) continue;
            await fn(interceptor);
        }
    }

    // 倒序遍历所有拦截器
    async forEachReverseAsync(fn: (interceptor: T) => Promise<void> | void): Promise<void> {
        for (let i = this.interceptorIds.length - 1; i >= 0; i--) {
            const id = this.interceptorIds[i];
            
            if (typeof id !== 'number') {
                continue;
            }
            const interceptor = this.interceptors.get(id);
            if (!interceptor) continue;
            await fn(interceptor);
        }
    }

    // 拦截器数量
    size(): number {
        return this.interceptors.size;
    }
}

export default InterceptorManager;