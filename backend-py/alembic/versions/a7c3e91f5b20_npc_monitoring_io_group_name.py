"""npc_monitoring_io_group_name

Revision ID: a7c3e91f5b20
Revises: dee544a23bc8
Create Date: 2026-10-04 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a7c3e91f5b20'
down_revision: Union[str, None] = 'dee544a23bc8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('npc_monitoring_io', sa.Column('group_name', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('npc_monitoring_io', 'group_name')
