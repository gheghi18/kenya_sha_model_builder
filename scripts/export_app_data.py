"""
Export data for the PMT Explorer web app (docs/).

Builds two files the static site loads in the browser:

- docs/data/households.csv : one row per KCHS 2021 household with the exact
  model features used in training (td_kchs_2021_filtered.csv), the label,
  the train/test split used in training, extra survey variables for the
  Model Lab, and pre-binned groups for the fairness checks.
- docs/data/meta.json      : variable schema with plain-language labels,
  baseline OLS coefficients, poverty lines and exclusion-regression results.

It reads the survey data and trained-model results from the kenya_analysis
project. By default that is ~/kenya_analysis; set KENYA_ANALYSIS to use another path.

Run:
    python scripts/export_app_data.py

Authors: Purity Mukami & Gabriel Geiger
"""
import sys
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd

import os

APP_ROOT = Path(__file__).resolve().parents[1]
ANALYSIS_ROOT = Path(os.environ.get("KENYA_ANALYSIS", Path.home() / "kenya_analysis")).resolve()
sys.path.append(str(ANALYSIS_ROOT))
from config import paths  # noqa: E402

OUT = APP_ROOT / "docs" / "data"
LABEL = "actual_consumption_log"
INFLATION_FACTOR = 1.211  # 2021 -> 2024, as in kenya_analysis/code/02_train/training_log.py

# ---------------------------------------------------------------------------
# Plain-language schema for the model's variables.
# `prefix` is the dummy-column prefix created in prep_kchs_data.ipynb;
# `raw` is the original categorical column in td_kchs_2021_all.csv, used to
# recover the reference (dropped) category.
# ---------------------------------------------------------------------------
MODEL_VARS = [
    # --- Where the household lives
    dict(key="County", theme="Where you live", label="County", question="Which county does the household live in?",
         type="categorical", prefix="county_", raw="County"),
    # --- Who lives there
    dict(key="household_size", theme="Who lives here", label="Household size", question="How many people live in the household?",
         type="numeric", col="household_size"),
    dict(key="mm_age", theme="Who lives here", label="Ages of household members", question="Combined age of everyone in the household (log of the sum of ages)",
         type="numeric", col="mm_age"),
    dict(key="prop_over65", theme="Who lives here", label="Share of people aged 65+", question="Share of household members aged 65 or older",
         type="numeric", col="prop_over65"),
    dict(key="prop_under5", theme="Who lives here", label="Share of young children (5 and under)", question="Share of household members aged 5 or younger",
         type="numeric", col="prop_under5"),
    dict(key="prop_m1864", theme="Who lives here", label="Share of working-age men", question="Share of household members who are men aged 18-64",
         type="numeric", col="prop_m1864"),
    dict(key="prop_w1864", theme="Who lives here", label="Share of working-age women", question="Share of household members who are women aged 18-64",
         type="numeric", col="prop_w1864"),
    # --- Household head
    dict(key="hhhead_woman", theme="Household head", label="Sex of household head", question="Is the household head a man or a woman?",
         type="categorical", prefix="hhhead_woman_", raw="hhhead_woman"),
    dict(key="working", theme="Household head", label="Head worked last week", question="Did the household head do any work last week?",
         type="binary", col="working_yes"),
    dict(key="marital_status", theme="Household head", label="Marital status of head", question="What is the household head's marital status?",
         type="categorical", prefix="marital_status_", raw="marital_status"),
    dict(key="education_level", theme="Household head", label="Education of head", question="What is the highest level of education the household head completed?",
         type="categorical", prefix="education_level_", raw="education_level"),
    dict(key="occupation", theme="Household head", label="Occupation of head", question="What kind of work does the household head mainly do?",
         type="categorical", prefix="occupation_", raw="occupation"),
    dict(key="d01_wage", theme="Household head", label="Head is a paid employee", question="Is the household head a paid employee?",
         type="binary", col="d1_wage_yes"),
    dict(key="d01_own_account", theme="Household head", label="Head works for themself", question="Does the household head run their own business (own-account worker)?",
         type="binary", col="d1_own_account_yes"),
    dict(key="d01_own_frm", theme="Household head", label="Head farms own land", question="Is the household head self-employed in small-scale farming?",
         type="binary", col="d1_own_frm_yes"),
    # --- The home
    dict(key="dwelling", theme="The home", label="Type of house", question="What type of house does the household live in?",
         type="categorical", prefix="dwelling_", raw="dwelling"),
    dict(key="nr_rooms", theme="The home", label="Number of sleeping rooms", question="How many rooms are used for sleeping?",
         type="numeric", col="nr_rooms"),
    dict(key="ownership_dwelling", theme="The home", label="Own or rent the home", question="Does the household own or rent the home?",
         type="categorical", prefix="ownership_dwelling_", raw="ownership_dwelling"),
    dict(key="roof_material", theme="The home", label="Roof material", question="What is the roof mainly made of?",
         type="categorical", prefix="roof_material_", raw="roof_material"),
    dict(key="wall_material", theme="The home", label="Wall material", question="What are the walls mainly made of?",
         type="categorical", prefix="wall_material_", raw="wall_material"),
    dict(key="floor_material", theme="The home", label="Floor material", question="What is the floor mainly made of?",
         type="categorical", prefix="floor_material_", raw="floor_material"),
    # --- Water, toilet, energy
    dict(key="drinking_water_source", theme="Water, toilet & energy", label="Drinking water source", question="Where does the household mainly get drinking water?",
         type="categorical", prefix="drinking_water_source_", raw="drinking_water_source"),
    dict(key="toilet_facility", theme="Water, toilet & energy", label="Toilet", question="What kind of toilet does the household use?",
         type="categorical", prefix="toilet_facility_", raw="toilet_facility"),
    dict(key="cooking_fuel_source", theme="Water, toilet & energy", label="Cooking fuel", question="What does the household mainly cook with?",
         type="categorical", prefix="cooking_fuel_source_", raw="cooking_fuel_source"),
    dict(key="lighting_source", theme="Water, toilet & energy", label="Lighting", question="What does the household mainly use for light?",
         type="categorical", prefix="lighting_source_", raw="lighting_source"),
    dict(key="access_electricity", theme="Water, toilet & energy", label="Has electricity", question="Does the household have electricity?",
         type="binary", col="access_electricity_yes"),
    # --- Things the household owns
    dict(key="own_radio", theme="Things you own", label="Radio", question="Owns a radio", type="binary", col="own_radio_yes"),
    dict(key="own_tv", theme="Things you own", label="TV", question="Owns a TV", type="binary", col="owns_tv_yes"),
    dict(key="own_phone", theme="Things you own", label="Mobile phone", question="Owns a mobile phone", type="binary", col="own_phone_yes"),
    dict(key="own_landline", theme="Things you own", label="Landline phone", question="Owns a landline phone", type="binary", col="own_landline_yes"),
    dict(key="own_desktop", theme="Things you own", label="Desktop computer", question="Owns a desktop computer", type="binary", col="own_desktop_yes"),
    dict(key="own_laptop", theme="Things you own", label="Laptop", question="Owns a laptop", type="binary", col="own_laptop_yes"),
    dict(key="own_tablet", theme="Things you own", label="Tablet", question="Owns a tablet", type="binary", col="own_tablet_yes"),
    dict(key="own_fridge", theme="Things you own", label="Fridge", question="Owns a fridge", type="binary", col="own_fridge_yes"),
    dict(key="own_hometheatre", theme="Things you own", label="Home theatre", question="Owns a home theatre system", type="binary", col="own_hometheatre_yes"),
    dict(key="own_bicycle", theme="Things you own", label="Bicycle", question="Owns a bicycle", type="binary", col="own_bicycle_yes"),
    dict(key="own_mtcycle", theme="Things you own", label="Motorcycle", question="Owns a motorcycle", type="binary", col="own_mtcycle_yes"),
    dict(key="own_car", theme="Things you own", label="Car", question="Owns a car", type="binary", col="own_car_yes"),
    dict(key="own_pickup", theme="Things you own", label="Pickup truck", question="Owns a pickup truck", type="binary", col="owns_pickup_yes"),
]

# ---------------------------------------------------------------------------
# Extra survey variables NOT used by SHA's model, offered in the Model Lab.
# Spending items are deliberately excluded: consumption is built from them,
# so adding them would "leak" the answer into the model.
# ---------------------------------------------------------------------------
EXTRA_YES_NO = [
    ("owns_mattresses", "Owns a mattress", "Everyday household items"),
    ("owns_mosquito_net", "Owns a mosquito net", "Everyday household items"),
    ("owns_blankets", "Owns blankets", "Everyday household items"),
    ("owns_curtains_and_accessories", "Owns curtains", "Everyday household items"),
    ("owns_jiko_charcoal", "Owns a charcoal jiko", "Everyday household items"),
    ("owns_kerosene_stove", "Owns a kerosene stove", "Everyday household items"),
    ("owns_electric_iron", "Owns an electric iron", "Electrical goods"),
    ("owns_antennae_aerial_satellite_decoder", "Owns a TV decoder / satellite dish", "Electrical goods"),
    ("owns_woofers_speakers_tuitors", "Owns speakers / woofers", "Electrical goods"),
    ("owns_water_dispenser", "Owns a water dispenser", "Electrical goods"),
    ("owns_micro_wave_oven", "Owns a microwave", "Electrical goods"),
    ("owns_washing_machine", "Owns a washing machine", "Electrical goods"),
    ("owns_sewing_machine", "Owns a sewing machine", "Livelihood"),
    # owns_boat_canoe left out: 20%+ "yes" in Nairobi suggests the item label is wrong in the source data
    ("owns_animal_drawn_vehicles", "Owns an animal-drawn cart", "Livelihood"),
    ("household_not_enough_food", "Worried there would not be enough food", "Hunger (self-reported)"),
    ("household_missed_meal", "Someone skipped a meal", "Hunger (self-reported)"),
    ("household_ran_out_of_food", "Household ran out of food", "Hunger (self-reported)"),
    ("household_without_food_for_day", "Someone went a whole day without eating", "Hunger (self-reported)"),
    ("household_cannot_eat_preferred_food", "Could not eat the foods they prefer", "Hunger (self-reported)"),
    ("household_fewer_kinds_of_food", "Ate fewer kinds of food", "Hunger (self-reported)"),
    ("household_ate_less_than_should", "Ate less than they should", "Hunger (self-reported)"),
    ("household_hungry_did_not_eat", "Was hungry but did not eat", "Hunger (self-reported)"),
    ("owns_electric_gas_cooker_meko", "Owns a gas or electric cooker", "Electrical goods"),
    ("owns_electric_kettle", "Owns an electric kettle", "Electrical goods"),
    ("owns_air_conditioner_fans", "Owns a fan or air conditioner", "Electrical goods"),
    ("owns_food_mixers_blenders_juicers", "Owns a blender", "Electrical goods"),
    ("owns_towels", "Owns towels", "Everyday household items"),
    ("employer_benefits_provided_nhif", "Head's employer pays for health insurance", "Work"),
    ("employer_benefits_provided_nssf", "Head's employer pays into a pension", "Work"),
]
# Yes/no questions worked out from other survey answers: (name, label, theme, function of the survey table)
EXTRA_DERIVED = [
    ("head_written_contract", "Head has a written work contract", "Work",
     lambda d: d["employment_basis_type"] == "A WRITTEN CONTRACT"),
    ("head_second_job", "Head has a second job", "Work",
     lambda d: d["second_job_main_employer"].notna()),
    ("head_big_workplace", "Head works somewhere with 10+ staff", "Work",
     lambda d: d["num_employees"].isin(["10 - 19", "20 - 49", "50 -99", "100 and Above"])),
    ("head_moved_county", "Head was born in another county", "Household head",
     lambda d: d["birth_location"].isin(["VILLAGE IN OTHER COUNTY", "TOWN/CITY IN OTHER COUNTY", "OUTSIDE KENYA"])),
    # Farming and livestock (from the raw livestock module, see livestock_flags). The survey does not
    # record how many animals a household owns, only whether it keeps livestock and what it sold.
    ("kept_livestock", "Kept livestock (last month)", "Livelihood", lambda d: d["lv_kept"]),
    ("sold_livestock", "Sold livestock (last month)", "Livelihood", lambda d: d["lv_sold"]),
    ("sold_cattle", "Sold cattle (last month)", "Livelihood", lambda d: d["lv_cattle"]),
    ("sold_goats_sheep", "Sold goats or sheep (last month)", "Livelihood", lambda d: d["lv_goats_sheep"]),
    ("sold_chickens", "Sold chickens (last month)", "Livelihood", lambda d: d["lv_chickens"]),
    ("sold_milk", "Sold milk (last month)", "Livelihood", lambda d: d["lv_milk"]),
    ("grew_crops", "Grew crops (last 12 months)", "Livelihood", lambda d: d["lv_crops"]),
    ("sold_crops", "Sold crops (last month)", "Livelihood", lambda d: d["lv_sold_crops"]),
]


def livestock_flags() -> pd.DataFrame:
    """Yes/no farming and livestock answers per household from the raw KCHS livestock module.
    Purchases of inputs are left out: they are spending and would leak into the model."""
    df = pd.read_stata(paths.KCHS_2021 / "livestock.dta")
    g = df.groupby("hhid")
    yes = lambda c: g[c].apply(lambda s: (s == "Yes").any())
    sold = lambda codes: g[[f"qc1_03__{i}" for i in codes]].max().max(axis=1) > 0
    out = pd.DataFrame({
        "lv_kept": yes("qc1_01"),
        "lv_sold": yes("qc1_02"),
        "lv_crops": yes("qa01"),
        "lv_sold_crops": yes("qa02"),
        "lv_cattle": sold([100, 102, 103, 104, 105, 106, 107, 108]),
        "lv_goats_sheep": sold([2, 3] + list(range(109, 117))),
        "lv_chickens": sold(range(801, 808)),
        "lv_milk": g[["qc2_02__12", "qc2_02__13", "qc2_02__14"]].max().max(axis=1) > 0,
    })
    out.index = out.index.astype(float)
    return out
EXTRA_CATEGORICAL = [
    ("household_type", "Type of farming household", "Livelihood",
     {"Mixed": "Mixed farming", "Crop Farming": "Crop farming", "Livestock Farming": "Livestock farming", "Non-farming": "Not farming"},
     "Non-farming"),
    ("respondent_religion", "Religion of household head", "Sensitive characteristics", None, None),
]
EXTRA_NUMERIC = [
    ("num_children", "Number of children (under 18)", "Who lives here"),
    ("age_household_head", "Age of household head", "Who lives here"),
]

EXTRA_NOTES = {
    "Hunger (self-reported)": "These answers come straight from the household. They are strongly linked to poverty, but in a real registration system people could easily change their answers to pay less.",
    "Sensitive characteristics": "Religion may make predictions more accurate, but charging people differently because of their religion would be discriminatory. Is a more accurate model always a fairer one?",
    "Everyday household items": "Cheap items that almost all households own (or don't). Do they tell the model anything new?",
    "Electrical goods": "Items that usually signal electricity access and higher spending.",
    "Livelihood": "How the household makes a living.",
    "Who lives here": "Simple counts that the model only captures indirectly.",
    "Work": "About the household head's main job. Most informal workers have no contract or benefits.",
}

# Fairness groups (mirrors code/03_analysis/fairness_tests.ipynb binning)
FAIRNESS_GROUPS = [
    ("g_sex", "Sex of household head"),
    ("g_electricity", "Has electricity"),
    ("g_women", "Share of working-age women"),
    ("g_education", "Education of household head"),
    ("g_head_age", "Age of household head"),
    ("g_hh_size", "Household size"),
    ("g_children", "Number of children"),
    ("g_region", "Region"),
    ("g_county", "County"),
    ("g_marital", "Marital status of head"),
    ("g_ownership", "Owns or rents home"),
    ("g_toilet", "Toilet"),
    ("g_farmer", "Head farms own land"),
]


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(s).lower()).strip("_")


LABEL_FIXES = {
    "Dont know": "Never attended school", "none": "Missing", "University(Undergraduate)": "University (undergraduate)",
    "University (Post Graduate)": "University (postgraduate)", "Secondary level": "Secondary",
    "Middle level college (certificate/diploma)": "College (certificate/diploma)",
    "Informal education (madrasa/adult basic)": "Informal (madrasa/adult basic)",
    "Other (specify)": "Other", "Other (Specify)": "Other", "Landie": "Landie (row of rooms)",
    "Concrete/ Cement/Terrazo": "Concrete/cement/terrazzo", "Palm/ bamboo": "Palm/bamboo",
    "Wall to wall Carpet": "Wall-to-wall carpet", "Stream/ River": "Stream/river",
    "Piped to yard/plot": "Piped to yard/plot", "VIP Pit Latrin": "VIP pit latrine",
    "Pit Latrine uncovered": "Pit latrine (uncovered)", "Pit latrine covered": "Pit latrine (covered)",
    "Open": "No toilet (open defecation)", "Battery(Car/Charged)": "Car battery",
    "Grass / Makuti thatch/twigs": "Grass/makuti thatch", "Dung / mud": "Dung/mud",
    "Iron sheets/Decra/Versatile": "Iron sheets", "Canvas/Nylon/Cartons/Cardboard": "Canvas/nylon/cardboard",
}


def nice(s: str) -> str:
    s = str(s).strip()
    if s.isupper():
        s = s.capitalize()
    s = re.sub(r"\s+", " ", s)
    return LABEL_FIXES.get(s, s)


def build_schema(features: list[str], all_df: pd.DataFrame) -> list[dict]:
    used = set()
    schema = []
    for v in MODEL_VARS:
        v = dict(v)
        if v["type"] in ("numeric", "binary"):
            assert v["col"] in features, v["col"]
            v["columns"] = [v["col"]]
            used.add(v["col"])
        else:
            cols = [f for f in features if f.startswith(v["prefix"])]
            assert cols, v["key"]
            used.update(cols)
            # Map raw categories -> dummy columns by fuzzy slug match
            raw_vals = sorted(all_df[v["raw"]].dropna().unique().tolist())
            cats, ref = [], None
            for raw in raw_vals:
                s = slug(raw)
                match = None
                for c in cols:
                    tail = slug(c[len(v["prefix"]):])
                    if tail == s:
                        match = c
                if match is None:
                    # second pass: loose match ignoring underscores
                    for c in cols:
                        if c[len(v["prefix"]):].replace("_", "") == s.replace("_", ""):
                            match = c
                cats.append({"label": nice(raw), "column": match})
            missing = [c for c in cats if c["column"] is None]
            # pd.get_dummies(drop_first=True) drops the alphabetically-first level
            ref = missing[0]["label"] if missing else None
            extra_unmatched = [c for c in cats if c["column"] is None][1:]
            # categories that never got their own column (rare levels dropped earlier)
            cats = [c for c in cats if c["column"] is not None or c["label"] == ref]
            mapped = {c["column"] for c in cats if c["column"]}
            for c in cols:
                if c not in mapped:
                    cats.append({"label": nice(c[len(v["prefix"]):].replace("_", " ")), "column": c})
            if v["key"] == "hhhead_woman":
                cats = [{"label": "Woman", "column": None}, {"label": "Man", "column": "hhhead_woman_male"}]
                ref = "Woman"
            v["categories"] = cats
            v["reference"] = ref
            v["columns"] = [c["column"] for c in cats if c["column"]]
            if extra_unmatched:
                v["note"] = "Rare answers not in the model: " + ", ".join(c["label"] for c in extra_unmatched)
        v.pop("prefix", None)
        v.pop("raw", None)
        schema.append(v)
    leftover = [f for f in features if f not in used]
    assert not leftover, f"Unmapped model columns: {leftover}"
    return schema


def bin_groups(df: pd.DataFrame) -> pd.DataFrame:
    g = pd.DataFrame(index=df.index)
    g["g_sex"] = df["hhhead_woman"].map({"Male": "Man", "Female": "Woman"})
    g["g_electricity"] = df["access_electricity"].map({"Yes": "Has electricity", "No": "No electricity"})
    g["g_women"] = pd.cut(df["prop_w1864"], [-0.001, 0, 0.25, 0.5, 0.75, 1.001],
                          labels=["No women", "Mostly men", "Mixed", "Mostly women", "All women"]).astype(str)
    g["g_education"] = df["education_level"].replace({"Dont know": "Never attended school"})
    g["g_head_age"] = pd.cut(df["age_household_head"], [15, 30, 40, 50, 60, np.inf],
                             labels=["Under 30", "30-39", "40-49", "50-59", "60+"], right=False).astype(str)
    g["g_hh_size"] = pd.cut(df["household_size"], [0, 1, 2, 4, 6, 1000],
                            labels=["1 person", "2 people", "3-4 people", "5-6 people", "7+ people"], right=True).astype(str)
    g["g_children"] = pd.cut(df["num_children"], [0, 1, 3, 5, 100],
                             labels=["No children", "1-2 children", "3-4 children", "5+ children"], right=False).astype(str)
    regions = pd.read_csv(paths.UTIL / "county_regions.csv")
    g["g_region"] = df["County"].map(dict(zip(regions["County"], regions["Region"])))
    g["g_county"] = df["County"]
    g["g_marital"] = df["marital_status"].map(nice)
    g["g_ownership"] = df["ownership_dwelling"].map(nice)
    g["g_toilet"] = df["toilet_facility"].map(nice)
    g["g_farmer"] = df["d01_own_frm"].map({"Yes": "Farms own land", "No": "Does not farm own land"})
    return g.fillna("Unknown").replace({"nan": "Unknown"})


def build_extras(all_df: pd.DataFrame) -> tuple[pd.DataFrame, list[dict]]:
    out = pd.DataFrame(index=all_df.index)
    schema = []
    for col, label, theme in EXTRA_YES_NO:
        name = "x_" + col
        out[name] = (all_df[col] == "Yes").astype(int)
        schema.append(dict(key=name, label=label, theme=theme, type="binary", columns=[name],
                           share=round(float(out[name].mean()), 3)))
    for col, label, theme, fn in EXTRA_DERIVED:
        name = "x_" + col
        out[name] = fn(all_df).astype(int)
        schema.append(dict(key=name, label=label, theme=theme, type="binary", columns=[name],
                           share=round(float(out[name].mean()), 3)))
    for col, label, theme, mapping, ref in EXTRA_CATEGORICAL:
        vals = all_df[col].fillna(ref if ref else "Unknown")
        if mapping is None:
            counts = vals.value_counts()
            keep = counts[counts >= 150].index.tolist()
            vals = vals.where(vals.isin(keep), "Other")
            mapping = {v: nice(v).replace("/ ", "/").title() for v in sorted(vals.unique())}
            ref = counts.index[0]
        vals = vals.map(lambda v: mapping.get(v, v))
        ref_label = mapping.get(ref, ref)
        cols = []
        for cat in sorted(vals.unique()):
            if cat == ref_label:
                continue
            name = f"x_{col}_{slug(cat)}"
            out[name] = (vals == cat).astype(int)
            cols.append({"label": cat, "column": name})
        schema.append(dict(key="x_" + col, label=label, theme=theme, type="categorical",
                           categories=[{"label": ref_label, "column": None}] + cols, reference=ref_label,
                           columns=[c["column"] for c in cols]))
    for col, label, theme in EXTRA_NUMERIC:
        name = "x_" + col
        out[name] = all_df[col].fillna(all_df[col].median())
        schema.append(dict(key=name, label=label, theme=theme, type="numeric", columns=[name]))
    return out, schema


def people_strings(hhids: pd.Series) -> pd.Series:
    """One string per household listing members as sex+age, e.g. 'F34|M36|F5'.
    Used by the app to rebuild a real household in the household builder."""
    ind = pd.read_csv(paths.INTERMEDIATE_DATA / "knbs_kchs_2021" / "kchs_2021_individuals.csv",
                      low_memory=False, usecols=["hhid", "age_years", "sex"])
    ind["p"] = ind["sex"].map({"Male": "M", "Female": "F"}).fillna("F") + \
        ind["age_years"].map(lambda a: "?" if pd.isna(a) else str(int(a)))
    people = ind.groupby("hhid")["p"].agg("|".join)
    return hhids.map(people)


def load_coefs(name: str) -> dict:
    x = pd.read_excel(paths.RESULTS / "model_stats" / f"{name}_stats.xlsx", sheet_name=None)
    coefs = x["Coefficients"]
    stats = dict(zip(x["Summary Stats"]["Statistic"], x["Summary Stats"]["Value"]))
    return {
        "coef": {r.term: float(r.Coefficient) for r in coefs.itertuples()},
        "pvalue": {r.term: float(r._5) for r in coefs.itertuples()},
        "r2_train": float(stats["R-squared"]),
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    td = pd.read_csv(paths.PROCESSED_DATA / "td_kchs_2021_filtered.csv")
    td = td.dropna(subset=[LABEL])
    all_df = pd.read_csv(paths.PROCESSED_DATA / "td_kchs_2021_all.csv", low_memory=False)
    all_df = all_df.set_index("hhid").loc[td["hhid"]].reset_index()
    val = pd.read_csv(paths.PROCESSED_DATA / "kchs_2021_validation.csv", usecols=["hhid"])

    features = [c for c in td.columns if c not in ("hhid", "urban_rural_classification", LABEL)]
    schema = build_schema(features, all_df)

    # Base columns
    base = pd.DataFrame({
        "hhid": td["hhid"].astype(int),
        "urban": (td["urban_rural_classification"] == "Urban").astype(int),
        "test": td["hhid"].isin(val["hhid"]).astype(int),
        "y": td[LABEL].round(5),
    })
    # Adult-equivalent scale (Anzagi-Bernard: 0-4 = 0.24, 5-14 = 0.65, 15+ = 1), used to turn
    # per-adult-equivalent consumption into a total for the whole household
    base["adq"] = all_df["adq_scale_consumption"].values
    # Household Paasche deflator: multiplying by it turns KNBS's deflated consumption back into
    # local nominal prices (same conversion as code/02_train/training_log.py)
    base["defl"] = all_df["pdeflator"].round(5).values
    base["people"] = people_strings(td["hhid"]).values

    feats = td[features].copy()
    for c in features:
        if set(feats[c].dropna().unique()) <= {0, 1}:
            feats[c] = feats[c].astype(int)
        else:
            feats[c] = feats[c].round(4)

    lv = livestock_flags()
    all_df = all_df.join(lv, on="hhid")
    for c in lv.columns:
        all_df[c] = all_df[c].fillna(False).astype(bool)
    extras, extra_schema = build_extras(all_df)
    groups = bin_groups(all_df)

    out = pd.concat([base.reset_index(drop=True), feats.reset_index(drop=True),
                     extras.reset_index(drop=True), groups.reset_index(drop=True)], axis=1)
    out.to_csv(OUT / "households.csv", index=False)

    # Poverty lines (KNBS 2021 absolute poverty line, KES per adult equivalent per month)
    pl = all_df.groupby("urban_rural_classification")["pl_abs"].first()

    # Exclusion regression (code/03_analysis/robustness_test.ipynb)
    reg = pd.read_csv(paths.RESULTS / "robustness" / "kchs_exclusion_regression.csv", index_col=0)
    col_label = {}
    for v in schema:
        if v["type"] == "categorical":
            for c in v["categories"]:
                if c["column"]:
                    col_label[c["column"]] = f'{v["label"]}: {c["label"]}'
        else:
            col_label[v["columns"][0]] = v["label"]
    exclusion_reg = [
        {"term": t, "label": col_label.get(t, t), "pp": round(float(r["percentage_points"]), 2),
         "p": float(r["P>|t|"]), "sig": r["sig"]}
        for t, r in reg.iterrows() if t != "const"
    ]

    meta = {
        "source": "KCHS 2021 (Kenya National Bureau of Statistics)",
        "features": features,
        "model_vars": schema,
        "extra_vars": extra_schema,
        "extra_notes": EXTRA_NOTES,
        "fairness_groups": [{"key": k, "label": l} for k, l in FAIRNESS_GROUPS],
        "poverty_line": {"Urban": float(pl["Urban"]), "Rural": float(pl["Rural"])},
        "baseline": {"urban": load_coefs("kchs_urban"), "rural": load_coefs("kchs_rural")},
        "exclusion_regression": exclusion_reg,
        "adult_equivalent_weights": {"0-4": 0.24, "5-14": 0.65, "15+": 1.0},
        # Same factor as code/02_train/training_log.py: 2021 -> 2024 prices
        "inflation_factor": INFLATION_FACTOR,
        "price_year": 2024,
        "deflator_median": {s: float(all_df.loc[all_df["urban_rural_classification"] == s, "pdeflator"].median())
                            for s in ("Urban", "Rural")},
        "n_households": int(len(out)),
        "n_test": int(out["test"].sum()),
    }
    with open(OUT / "meta.json", "w") as f:
        json.dump(meta, f, indent=1)

    print(f"Wrote {len(out):,} households ({out['test'].sum():,} test) "
          f"with {out.shape[1]} columns to {OUT / 'households.csv'}")
    print(f"Poverty lines: {meta['poverty_line']}")


if __name__ == "__main__":
    main()
