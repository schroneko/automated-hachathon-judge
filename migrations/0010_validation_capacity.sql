UPDATE devday_judge_budget_accounts SET limit_micro_usd = 40000000 WHERE mode = 'validation' AND limit_micro_usd < 40000000;
