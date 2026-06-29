import { Injectable } from '@nestjs/common';

import { isNonEmptyArray } from 'twenty-shared/utils';

import { type ConfigVariables } from 'src/engine/core-modules/twenty-config/config-variables';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { DefaultAiCatalogService } from 'src/engine/metadata-modules/ai/ai-models/services/default-ai-catalog.service';

import { type AiProviderConfig } from 'src/engine/metadata-modules/ai/ai-models/types/ai-provider-config.type';
import { type AiProvidersConfig } from 'src/engine/metadata-modules/ai/ai-models/types/ai-providers-config.type';
import { extractConfigVariableName } from 'src/engine/metadata-modules/ai/ai-models/utils/extract-config-variable-name.util';

@Injectable()
export class ProviderConfigService {
  constructor(
    private readonly twentyConfigService: TwentyConfigService,
    private readonly defaultAiCatalogService: DefaultAiCatalogService,
  ) {}

  getCatalogProviderNames(): Set<string> {
    return new Set(
      Object.keys(this.defaultAiCatalogService.getDefaultAiCatalog()),
    );
  }

  getResolvedProviders(): AiProvidersConfig {
    const rawCatalog = this.defaultAiCatalogService.getDefaultAiCatalog();
    // Only resolve {{VAR}} templates in the committed catalog — never in
    // user-supplied custom providers, to prevent config variable exfiltration.
    const catalog = this.resolveTemplates(rawCatalog);
    const custom = this.twentyConfigService.get('AI_PROVIDERS') ?? {};

    const resolved: AiProvidersConfig = { ...catalog };

    for (const [providerKey, customConfig] of Object.entries(custom)) {
      // The admin panel form only stores credentials (apiKey/npm/label) — never
      // the model list. A naive shallow merge would let that partial entry wipe
      // the catalog's npm + models, leaving the provider with zero registrable
      // models. Deep-merge each custom provider on top of its catalog base so it
      // inherits npm + models unless it explicitly overrides them.
      const catalogBase = this.findCatalogBase(catalog, providerKey, customConfig);

      if (!catalogBase) {
        resolved[providerKey] = customConfig;
        continue;
      }

      resolved[providerKey] = {
        ...catalogBase,
        ...customConfig,
        // Keep the catalog's models unless the custom entry brings its own.
        models:
          isNonEmptyArray(customConfig.models)
            ? customConfig.models
            : catalogBase.models,
      };
    }

    return resolved;
  }

  // Matches a custom provider to its built-in catalog entry so credential-only
  // entries inherit npm + models. Tries the provider key, then the models.dev
  // `name`, then a unique npm match (all case-insensitive).
  private findCatalogBase(
    catalog: AiProvidersConfig,
    providerKey: string,
    customConfig: AiProviderConfig,
  ): AiProviderConfig | undefined {
    const catalogKeys = Object.keys(catalog);

    const keyMatch = catalogKeys.find(
      (key) => key.toLowerCase() === providerKey.toLowerCase(),
    );

    if (keyMatch) {
      return catalog[keyMatch];
    }

    if (customConfig.name) {
      const nameMatch = catalogKeys.find(
        (key) => key.toLowerCase() === customConfig.name?.toLowerCase(),
      );

      if (nameMatch) {
        return catalog[nameMatch];
      }
    }

    if (customConfig.npm) {
      const npmMatches = catalogKeys.filter(
        (key) => catalog[key].npm === customConfig.npm,
      );

      if (npmMatches.length === 1) {
        return catalog[npmMatches[0]];
      }
    }

    return undefined;
  }

  private resolveTemplates(providers: AiProvidersConfig): AiProvidersConfig {
    const result: AiProvidersConfig = {};

    for (const [name, config] of Object.entries(providers)) {
      result[name] = this.resolveProviderTemplates(config);
    }

    return result;
  }

  private resolveProviderTemplates(config: AiProviderConfig): AiProviderConfig {
    return {
      ...config,
      baseUrl: this.resolveTemplate(config.baseUrl),
      apiKey: this.resolveTemplate(config.apiKey),
      accessKeyId: this.resolveTemplate(config.accessKeyId),
      secretAccessKey: this.resolveTemplate(config.secretAccessKey),
    };
  }

  private resolveTemplate(value?: string): string | undefined {
    if (!value) {
      return value;
    }

    const varName = extractConfigVariableName(value);

    if (!varName) {
      return value;
    }

    // Registered config variables first (supports admin panel / DB overrides),
    // then fall back to process.env for vars not in ConfigVariables
    // (e.g. when CI replaces the catalog with custom provider entries).
    try {
      const resolved = this.twentyConfigService.get(
        varName as keyof ConfigVariables,
      ) as string | undefined;

      if (resolved) {
        return resolved;
      }
    } catch {
      // Not a registered config variable — fall through to env
    }

    return process.env[varName] || undefined;
  }
}
