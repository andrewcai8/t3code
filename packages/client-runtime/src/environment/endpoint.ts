export * from "@t3tools/shared/advertisedEndpoint";

/** Resolve an environment route inside the base URL's optional path prefix. */
export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  const prefix = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  url.pathname = `${prefix}${pathname.replace(/^\/+/, "")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};
