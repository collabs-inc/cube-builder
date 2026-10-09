declare module "@postlight/parser" {
  export interface PostlightParseResult {
    title: string | null;
    author: string | null;
    date_published: string | null;
    dek: string | null;
    lead_image_url: string | null;
    content: string | null;
    next_page_url: string | null;
    url: string;
    domain: string;
    excerpt: string | null;
    word_count: number;
    direction: "ltr" | "rtl";
    total_pages: number;
    rendered_pages: number;
  }

  const Parser: {
    parse(
      url: string,
      options?: {
        contentType?: "html" | "markdown" | "text";
        headers?: Record<string, string>;
        html?: string;
      },
    ): Promise<PostlightParseResult | null>;
  };

  export default Parser;
}
