-- A reserve pool is a quote without a recipe: the application names profiles and call limits, each call is priced when it is made.
ALTER TABLE quotes DROP CONSTRAINT quotes_kind_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_kind_check CHECK(kind IN ('single_call','recipe','pool'));
ALTER TABLE quotes ALTER COLUMN recipe_id DROP NOT NULL;
ALTER TABLE quotes ADD CONSTRAINT quotes_pool_recipe CHECK((kind='pool')=(recipe_id IS NULL));
