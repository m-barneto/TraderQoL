import { DependencyContainer } from "tsyringe";

import { jsonc } from "jsonc";
import path from "path";
import { ITrader } from "@spt/models/eft/common/tables/ITrader";
import { QuestRewardType } from "@spt/models/enums/QuestRewardType";
import { IPostDBLoadMod } from "@spt/models/external/IPostDBLoadMod";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { DatabaseServer } from "@spt/servers/DatabaseServer";
import { VFS } from "@spt/utils/VFS";


const roubleId = "5449016a4bdc2d6f028b456f";
const dollarId = "5696686a4bdc2da3298b456a";
const euroId = "569668774bdc2da2298b4568";

//#region ModConfig
interface ModConfig {
    priceMultiplier: number;
    minSalesMultiplier: number;
    traderStockMultiplier: number;
    unlimitedTraderStock: boolean;
    singleCurrencySettings: SingleCurrencySettings;
    questReputationSettings: QuestReputationSettings;
    insuranceSettings: InsuranceSettings;
    repairSettings: RepairSettings;
}

interface RepairSettings {
    enabled: boolean;
    repairCostMultiplier: number;
}

interface InsuranceSettings {
    enabled: boolean;
    insuranceCostMultiplier: number;
}

interface QuestReputationSettings {
    enabled: boolean;
    repMultiplier: number;
    multiplyNegativeReputationRewards: boolean;
}

interface SingleCurrencySettings {
    enabled: boolean;
    targetCurrency: string;
    dollarExchangeRate: number;
    euroExchangeRate: number;
}
//#endregion

class TraderQoL implements IPostDBLoadMod {
    private modConfig: ModConfig;
    private logger: ILogger;

    public postDBLoad(container: DependencyContainer): void {
        const databaseServer = container.resolve<DatabaseServer>("DatabaseServer");
        const vfs = container.resolve<VFS>("VFS");
        this.logger = container.resolve<ILogger>("WinstonLogger");

        this.modConfig = jsonc.parse(vfs.readFile(path.resolve(__dirname, "../config/config.jsonc")));

        const traderTable = databaseServer.getTables().traders;
        // Iterate over all traders
        for (const traderId in traderTable) {
            const trader = traderTable[traderId];
            const nickname = trader.base.nickname;
            // Unknown and caretaker are excluded
            if (nickname === "caretaker" || nickname === "Unknown" || nickname === "БТР") continue;
            
            this.updateTrader(trader);
        }

        if (this.modConfig.questReputationSettings.enabled) {
            const questTable = databaseServer.getTables().templates.quests;
            
            // Iterate over all quests
            for (const questId in questTable) {
                const quest = questTable[questId];

                // Modify quest rewards
                const questRewards = quest.rewards.Success;
                for (const rewardIdx in questRewards) {
                    const reward = questRewards[rewardIdx];
                    if (reward.type == QuestRewardType.TRADER_STANDING) {
                        const prevValue = Number(reward.value);
                        if (prevValue < 0.0 && !this.modConfig.questReputationSettings.multiplyNegativeReputationRewards) {
                            continue;
                        }
                        // round this to nearest 1/100th
                        reward.value = Math.ceil(prevValue * Number(this.modConfig.questReputationSettings.repMultiplier) * 100) / 100;
                    }
                }
            }
        }
    }

    private getConversionRate(fromCurrency, targetCurrency): number {
        if (fromCurrency == targetCurrency) return 1.0;

        if (fromCurrency == "EUR") {
            if (targetCurrency == "USD") {
                // euro to rouble first, then to usd
                return this.getConversionRate(fromCurrency, "RUB") * this.modConfig.singleCurrencySettings.dollarExchangeRate;
            } else if (targetCurrency == "RUB") {
                return this.modConfig.singleCurrencySettings.euroExchangeRate;
            }
        }
        if (fromCurrency == "USD") {
            if (targetCurrency == "EUR") {
                return this.getConversionRate(fromCurrency, "RUB") * this.modConfig.singleCurrencySettings.euroExchangeRate;
            } else if (targetCurrency == "RUB") {
                return this.modConfig.singleCurrencySettings.dollarExchangeRate;
            }
        }
        if (fromCurrency == "RUB") {
            if (targetCurrency == "EUR") {
                return 1.0 / this.modConfig.singleCurrencySettings.euroExchangeRate;
            } else if (targetCurrency == "USD") {
                return 1.0 / this.modConfig.singleCurrencySettings.dollarExchangeRate;
            }
        }
        
        
        this.logger.error(`[TraderQoL] Failed to convert from ${fromCurrency} to ${targetCurrency}.`);
        return 1.0;
    }

    private getCurrencyId(currency) {
        switch (currency) {
            case "RUB":
                return roubleId;
            case "EUR":
                return euroId;
            case "USD":
                return dollarId;
        }
        this.logger.error(`[TraderQoL] Failed to get id from currency name ${currency}.`);
        return null;
    }

    private getCurrencyName(currencyId) {
        switch (currencyId) {
            case roubleId:
                return "RUB";
            case euroId:
                return "EUR";
            case dollarId:
                return "USD";
        }
        this.logger.error(`[TraderQoL] Failed to get currency name from ID ${currencyId}.`);
        return null;
    }

    private isCurrencyItem(itemId) {
        switch (itemId) {
            case roubleId:
            case euroId:
            case dollarId:
                return true;
            default:
                return false;
        }
    }

    private updateTrader(trader: ITrader) {
        if (this.modConfig.singleCurrencySettings.enabled) {
            // If we need to do a currency conversion, do it here.
            if (trader.base.currency != this.modConfig.singleCurrencySettings.targetCurrency) {
                const exchangeRate = this.getConversionRate(trader.base.currency, this.modConfig.singleCurrencySettings.targetCurrency)
                // Modify trader loyalty levels to reflect their new currency
                for (const loyaltyLevelId in trader.base.loyaltyLevels) {
                    trader.base.loyaltyLevels[loyaltyLevelId].minSalesSum *= exchangeRate;
                }
                
                // Set trader to use target currency
                trader.base.currency = this.modConfig.singleCurrencySettings.targetCurrency;
            }

            // Convert trader stock to target currency
            const targetCurrencyId = this.getCurrencyId(this.modConfig.singleCurrencySettings.targetCurrency);

            // Get the trader's stock
            const barters = trader.assort.barter_scheme;
            for (const barterId in barters) {
                // Get the barterInfo for the trade
                const barterInfo = barters[barterId];
                for (const barterInfoId in barterInfo) {
                    // Get the trade in items for the barter
                    const barterEntrys = barterInfo[barterInfoId];

                    // If it's a barter that takes in multiple items then continue, normal items for sale will only have one entry, the currency cost
                    if (barterEntrys.length > 1) continue;

                    // Get the cost
                    const item = barterEntrys[0];
                    // If it's price is not our targetCurrency
                    if (this.isCurrencyItem(item._tpl) && this.getCurrencyName(item._tpl) !== this.modConfig.singleCurrencySettings.targetCurrency) {
                        // Change it's count (price) to reflect the exchange rate
                        const exchangeRate = this.getConversionRate(this.getCurrencyName(item._tpl), this.modConfig.singleCurrencySettings.targetCurrency);
                        item.count = Math.max(1.0, Math.round(item.count * exchangeRate));

                        // Change the cost currency to our target currency id
                        item._tpl = targetCurrencyId;
                    }
                }
            }
        }

        
        if (this.modConfig.minSalesMultiplier != 1.0) {
            for (const loyaltyLevelId in trader.base.loyaltyLevels) {
                trader.base.loyaltyLevels[loyaltyLevelId].minSalesSum *= this.modConfig.minSalesMultiplier;
            }
        }
        
        if (this.modConfig.priceMultiplier != 1.0) {
            // Get the trader's stock
            const barters = trader.assort.barter_scheme;
            for (const barterId in barters) {
                // Get the barterInfo for the trade
                const barterInfo = barters[barterId];
                for (const barterInfoId in barterInfo) {
                    // Get the trade in items for the barter
                    const barterEntrys = barterInfo[barterInfoId];

                    // If it's a barter that takes in multiple items then continue, normal items for sale will only have one entry, the currency cost
                    if (barterEntrys.length > 1) continue;

                    const item = barterEntrys[0];
                    // Make sure the item is a currency
                    if (this.isCurrencyItem(item._tpl)) {
                        // Change it's count (price)
                        item.count *= this.modConfig.priceMultiplier;
                    }
                }
            }
        }

        if (this.modConfig.traderStockMultiplier != 1.0 || this.modConfig.unlimitedTraderStock) {
            const items = trader.assort.items;
            for (const itemId in items) {
                const item = items[itemId];
                if (this.modConfig.unlimitedTraderStock) {
                    item.upd.BuyRestrictionMax = Math.max(1.0, Math.round(item.upd.BuyRestrictionMax * this.modConfig.traderStockMultiplier));
                } else {
                    item.upd.UnlimitedCount = true;
                }
            }
        }

        if (trader.base.insurance.availability && this.modConfig.insuranceSettings.enabled && this.modConfig.insuranceSettings.insuranceCostMultiplier != 1.0) {
            for (const loyaltyLevelId in trader.base.loyaltyLevels) {
                trader.base.loyaltyLevels[loyaltyLevelId].insurance_price_coef *= this.modConfig.insuranceSettings.insuranceCostMultiplier;
            }
        }

        if (trader.base.repair.availability && this.modConfig.repairSettings.enabled && this.modConfig.repairSettings.repairCostMultiplier != 1.0) {
            for (const loyaltyLevelId in trader.base.loyaltyLevels) {
                trader.base.loyaltyLevels[loyaltyLevelId].repair_price_coef *= this.modConfig.repairSettings.repairCostMultiplier;
            }
        }
    }
}

module.exports = { mod: new TraderQoL() };
