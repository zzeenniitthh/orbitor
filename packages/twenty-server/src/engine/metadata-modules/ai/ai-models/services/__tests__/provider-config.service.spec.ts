import { Test, type TestingModule } from '@nestjs/testing';

import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { DefaultAiCatalogService } from 'src/engine/metadata-modules/ai/ai-models/services/default-ai-catalog.service';
import { ProviderConfigService } from 'src/engine/metadata-modules/ai/ai-models/services/provider-config.service';
import { type AiProvidersConfig } from 'src/engine/metadata-modules/ai/ai-models/types/ai-providers-config.type';

describe('ProviderConfigService', () => {
  let service: ProviderConfigService;
  let twentyConfigService: { get: jest.Mock };
  let defaultAiCatalogService: { getDefaultAiCatalog: jest.Mock };

  const catalog: AiProvidersConfig = {
    google: {
      npm: '@ai-sdk/google',
      label: 'Google',
      apiKey: '{{GOOGLE_API_KEY}}',
      models: [
        { name: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
        { name: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      ],
    },
  };

  beforeEach(async () => {
    twentyConfigService = { get: jest.fn() };
    defaultAiCatalogService = {
      getDefaultAiCatalog: jest.fn().mockReturnValue(catalog),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProviderConfigService,
        { provide: TwentyConfigService, useValue: twentyConfigService },
        { provide: DefaultAiCatalogService, useValue: defaultAiCatalogService },
      ],
    }).compile();

    service = module.get<ProviderConfigService>(ProviderConfigService);
  });

  // The admin "Add AI Provider" form stores only credentials (npm/label/apiKey)
  // and never a models array — a shallow merge would wipe the catalog's models.
  it('should keep the catalog models when a custom provider only supplies an api key', () => {
    twentyConfigService.get.mockImplementation((key: string) =>
      key === 'AI_PROVIDERS'
        ? { google: { npm: '@ai-sdk/google', label: 'Google', apiKey: 'sk-live' } }
        : undefined,
    );

    const resolved = service.getResolvedProviders();

    expect(resolved.google.apiKey).toBe('sk-live');
    expect(resolved.google.models).toHaveLength(2);
  });

  it('should inherit the catalog base via the models.dev name when the key differs', () => {
    twentyConfigService.get.mockImplementation((key: string) =>
      key === 'AI_PROVIDERS'
        ? {
            'google-eu': {
              npm: '@ai-sdk/google',
              name: 'google',
              label: 'Google EU',
              apiKey: 'sk-eu',
            },
          }
        : undefined,
    );

    const resolved = service.getResolvedProviders();

    expect(resolved['google-eu'].models).toHaveLength(2);
    expect(resolved['google-eu'].apiKey).toBe('sk-eu');
  });

  it('should let a custom provider override the catalog models when it supplies its own', () => {
    twentyConfigService.get.mockImplementation((key: string) =>
      key === 'AI_PROVIDERS'
        ? {
            google: {
              npm: '@ai-sdk/google',
              apiKey: 'sk-live',
              models: [{ name: 'gemini-custom', label: 'Custom' }],
            },
          }
        : undefined,
    );

    const resolved = service.getResolvedProviders();

    expect(resolved.google.models).toHaveLength(1);
    expect(resolved.google.models?.[0].name).toBe('gemini-custom');
  });

  it('should keep a truly custom provider (no catalog match) untouched', () => {
    twentyConfigService.get.mockImplementation((key: string) =>
      key === 'AI_PROVIDERS'
        ? {
            'my-proxy': {
              npm: '@ai-sdk/openai-compatible',
              baseUrl: 'https://proxy.example.com/v1',
              apiKey: 'sk-proxy',
            },
          }
        : undefined,
    );

    const resolved = service.getResolvedProviders();

    expect(resolved['my-proxy'].baseUrl).toBe('https://proxy.example.com/v1');
    expect(resolved['my-proxy'].models).toBeUndefined();
  });
});
