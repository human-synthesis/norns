export namespace page {
    /**
     * Wrap a SvelteKit `load`.
     *
     * @param {{ handler: (ctx: LoadContext) => any | Promise<any> }} opts
     * @returns {(event: ServerLoadEvent) => Promise<any>}
     */
    function load(opts: {
        handler: (ctx: LoadContext) => any | Promise<any>;
    }): (event: ServerLoadEvent) => Promise<any>;
    /**
     * Wrap a SvelteKit `actions` object. Each action takes `{ input?, run }`
     * — `input` is a schema, `run` is the handler.
     *
     * The body is read with the same reader as `route()`, so the app-wide
     * serializer's `parseBody` applies here too. Note that SvelteKit itself
     * only dispatches form-encoded POSTs to actions (anything else is a 415
     * before this code runs); clients posting JSON or TRON must target a
     * `+server.c` route.
     *
     * @param {Record<string, { input?: any, run: (ctx: ActionContext) => any | Promise<any> }>} spec
     * @returns {Record<string, (event: RequestEvent) => Promise<any>>}
     */
    function actions(spec: Record<string, {
        input?: any;
        run: (ctx: ActionContext) => any | Promise<any>;
    }>): Record<string, (event: RequestEvent) => Promise<any>>;
}
export type ServerLoadEvent = import("@sveltejs/kit").ServerLoadEvent;
export type RequestEvent = import("@sveltejs/kit").RequestEvent;
export type Container = import("./container.js").Container;
export type LoadContext = {
    container: Container;
    event: ServerLoadEvent;
    params: ServerLoadEvent["params"];
    url: ServerLoadEvent["url"];
    user: any;
};
export type ActionContext = {
    /**
     * parsed form data (after validation)
     */
    input: any;
    container: Container;
    event: RequestEvent;
    user: any;
};
