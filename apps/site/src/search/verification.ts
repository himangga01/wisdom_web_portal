export interface SearchVerificationEnvironment {
  GOOGLE_SITE_VERIFICATION_DNS?: string;
  NAVER_SITE_VERIFICATION_META?: string;
  NAVER_SITE_VERIFICATION_FILE?: string;
}

export interface SearchVerificationConfig {
  googleDnsRecord?: string;
  naverMetaToken?: string;
  naverFile?: { filename: string; content: string };
}

const PLACEHOLDER_PATTERN = /^(?:#|change[_ -]?me|your[_ -].*|naver-site-verification(?:\.html)?)$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{24,256}$/;
const GOOGLE_DNS_PATTERN = /^google-site-verification=([A-Za-z0-9_-]{24,256})$/;
const NAVER_FILE_PATTERN = /^naver[A-Za-z0-9_-]{24,128}\.html$/;

function configured(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate || PLACEHOLDER_PATTERN.test(candidate)) return undefined;
  return candidate;
}

export function parseSearchVerificationConfig(
  environment: SearchVerificationEnvironment,
): SearchVerificationConfig {
  const googleDnsRecord = configured(environment.GOOGLE_SITE_VERIFICATION_DNS);
  const naverMetaToken = configured(environment.NAVER_SITE_VERIFICATION_META);
  const naverFilename = configured(environment.NAVER_SITE_VERIFICATION_FILE);

  if (googleDnsRecord && !GOOGLE_DNS_PATTERN.test(googleDnsRecord)) {
    throw new Error("SEARCH_VERIFICATION_INVALID");
  }
  if (naverMetaToken && !TOKEN_PATTERN.test(naverMetaToken)) {
    throw new Error("SEARCH_VERIFICATION_INVALID");
  }
  if (naverFilename && !NAVER_FILE_PATTERN.test(naverFilename)) {
    throw new Error("SEARCH_VERIFICATION_INVALID");
  }
  if (naverMetaToken && naverFilename) {
    throw new Error("SEARCH_VERIFICATION_AMBIGUOUS");
  }

  return {
    ...(googleDnsRecord ? { googleDnsRecord } : {}),
    ...(naverMetaToken ? { naverMetaToken } : {}),
    ...(naverFilename ? {
      naverFile: {
        filename: naverFilename,
        content: `naver-site-verification: ${naverFilename}`,
      },
    } : {}),
  };
}
