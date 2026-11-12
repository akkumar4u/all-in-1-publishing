# Private Vercel parser setup

This service keeps the Google Docs parsing code in the private GitHub repository. Salesforce login, WordPress editing, and browser tab automation continue to run in the Chrome extension.

## First deployment

1. In Vercel, import the private `akkumar4u/all-in-1-publishing` GitHub repository.
2. Set the project Root Directory to the repository root and the Framework Preset to **Other**.
3. Add an environment variable named `CONTENT_STUDIO_API_KEY` for Production, Preview, and Development. Generate a long random value locally; never add it to GitHub or the extension source.
4. Deploy the project. The API health route is `/api/healthz`; document parsing uses `/api/parse`.
5. In the extension, open **Bulk dashboard → Settings**, enter the Vercel deployment URL and the same key, then click **Test private server**.

Pushes to `main` redeploy the Vercel project after the GitHub repository is connected. The GitHub Actions build also creates the installable extension artifact.

## Data and access

The extension sends exported Google Docs HTML and the dealership hostname to `/api/parse`; it does not send Salesforce ticket numbers, account names, or WordPress credentials to this service. The server does not log document bodies. The access key is saved only in the local Chrome profile and checked against the Vercel environment variable. It is not packaged into the extension.

The extension build omits `hub_parser.js`, `blog_parser.js`, and `parser.html`; Vercel reads the parser source from the private repository. Chrome-only Salesforce and WordPress automation remains in the extension because it needs the user's active Chrome session. The Vercel endpoint is not a remote JavaScript loader.
